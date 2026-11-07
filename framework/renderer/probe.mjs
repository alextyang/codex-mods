// ProbeReport (contracts/adapter.d.ts): which adapter items resolved in THIS window. Keys: 'anchor:<AnchorName>',
// 'component:<ComponentName>', 'react'. Anchors are page-state dependent (Settings or a thread may not be open
// yet), so an anchor that has resolved at least once stays true for the life of the page; the report is re-posted whenever the
// set changes. The Runtime publishes the union over open windows (bus state framework/probe).
import { ANCHOR_NAMES } from './anchors.mjs';
import { COMPONENT_NAMES } from './components.mjs';

export function createProbe({ appBuild, anchors, components, getReact, bindingReport = () => ({}), bindingStates = () => ({}), rulesReport = () => ({}), post, now = () => new Date().toISOString(), schedule, intervalMs = 2000, onTick = () => {}, isReady = () => true, authoritative = true, log = () => {} }) {
  const seenAnchors = new Set();
  const seenComponents = new Set();
  let lastKey = null;
  let cancel = null;
  let running = false;
  let complete = false;        // sticky: once authoritative, always authoritative

  function compute() {
    const items = {};
    items.react = Boolean(getReact());
    for (const n of ANCHOR_NAMES) {
      if (anchors.defined(n) && !seenAnchors.has(n) && anchors.resolve(n)) seenAnchors.add(n);
      items[`anchor:${n}`] = seenAnchors.has(n);
    }
    for (const n of COMPONENT_NAMES) {
      if (!seenComponents.has(n) && components.isReal(n)) seenComponents.add(n);
      items[`component:${n}`] = seenComponents.has(n);
    }
    // A presentation binding works on this build once it matched its component and, if it names one, an instance the graph has.
    for (const [id, ok] of Object.entries(bindingReport())) items[`binding:${id}`] = ok === true;
    // The mods' presentation rules in this window (docs/design/systems.md E2): `rule:<mod>/<id>` true while it applies (false: tripped),
    // `applied:<binding>` true once a binding applied a rule.
    for (const [k, ok] of Object.entries(rulesReport())) items[k] = ok === true;
    return items;
  }

  function update() {
    const items = compute();
    // `complete` (contracts/adapter.d.ts): false for the bootstrap report sent at attach and for every report of a window that never
    // renders the app (mod-view windows); true ONLY once the app shell is ready (React exposed and a shell anchor resolvable). There
    // is no timer path: a page that never reaches the shell (the sign-in screen) stays incomplete, so compatibility treats UI items as
    // unverified rather than missing. The Host must not judge compatibility from complete:false reports.
    if (authoritative && running && !complete && isReady({ items })) complete = true;
    let bindings;
    try { bindings = bindingStates() ?? {}; } catch { bindings = {}; }
    const key = JSON.stringify([complete, Object.entries(items).sort(([a], [b]) => (a < b ? -1 : 1)), Object.entries(bindings).sort(([a], [b]) => (a < b ? -1 : 1))]);
    if (key === lastKey) return false;
    lastKey = key;
    try { post({ t: 'probe', report: { appBuild, at: now(), items, bindings, complete: authoritative && complete } }); } catch (e) { log('probe post failed', { error: String(e?.message ?? e) }); }
    return true;
  }
  function tick() { if (!running) return; try { onTick(); } catch (e) { log('probe tick hook failed', { error: String(e?.message ?? e) }); } update(); cancel = schedule(tick, intervalMs); }

  return {
    compute, update,
    /** Post now, then keep re-checking (cheap: nine selector queries). */
    start() {
      if (running) return;
      running = true;
      tick();
    },
    stop() { running = false; cancel?.(); cancel = null; },
  };
}
