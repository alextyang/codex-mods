// A build's status in the feature log (docs/design/systems.md S17, "E4 in detail"): each mechanic judged by its kind from the build's
// evidence (its pack, its census, its refresh report, and for the running copy what its windows saw), each feature the worst of what it
// needs (a concept the best of its realizations), and the comparison of two builds' results. Pure: the evidence comes in as data.
// - present: the evidence sees it (and its fingerprint, where it has one, is one a reference build had);
// - changed: seen with a fingerprint no reference build had, or a binding whose canary tripped;
// - missing: a complete enumeration of its kind lacks it (or the pack, for anchors, which it enumerates);
// - unknown: anything else (no census, a partial family, a carried-over catalog, a locator miss, not seen yet).
// Present means the checked needs were found, not that the feature was proven to work.
// Node built-ins only (none needed).

export const RANK = Object.freeze({ present: 0, unknown: 1, changed: 2, missing: 3 });
const CATEGORIES = ['ClientRequest', 'ServerRequest', 'ClientNotification', 'ServerNotification'];
/** The census family that enumerates each kind, and when that enumeration is complete (no residue left unresolved). */
const FAMILIES = {
  service: { ids: ['apphost.services'], complete: (f) => !(f.unresolved?.length) },
  message: { ids: ['bus.toView'], complete: (f) => !(f.parts?.enumMemberLabelsUnresolved) && !(f.unresolved?.length) },
  fromView: { ids: ['bus.fromView'], complete: (f) => !(f.unresolved?.length) },
  command: { ids: ['commands.ids'], complete: (f) => !f.unresolvedElements && !(Array.isArray(f.unresolved) ? f.unresolved.length : f.unresolved) },
  route: { ids: ['routes.paths'], complete: (f) => !(Array.isArray(f.unresolved) ? f.unresolved.length : f.unresolved) },
  state: { ids: ['state.globalKeys', 'state.persistedAtoms'], complete: (f) => !(Array.isArray(f.unresolved) ? f.unresolved.length : f.unresolved) },
};
const SEAMS = new Set(['jsx', 'lazy', 'taps', 'menuItems', 'launcher', 'markdown', 'copy', 'command', 'attach', 'reviewAction', 'pullRequestCreate', 'appHost', 'sidebarGroups', 'tabVisible', 'responsive', 'pageRoute', 'destinations', 'railMode']);

const kindOf = (id) => { const i = typeof id === 'string' ? id.indexOf(':') : -1; return i < 0 ? null : id.slice(0, i); };
const nameOf = (id) => id.slice(id.indexOf(':') + 1);
const family = (ev, id) => { const f = ev.facts?.families?.[id]; return f && f.status === 'ok' ? f : null; };

/**
 * One mechanic, by its kind, from a build's evidence (whether or not the log names it).
 * @param {string} id
 * @param {{ pack: object, facts?: object|null, report?: object|null, addressesSha256?: string|null, live?: { bindings?: object, anchors?: string[] }|null,
 *   stale?: string[] }} ev  `stale`: the pieces of evidence that do not belong to this build (their kinds read unknown)
 * @param {object} log
 * @returns {{ status: 'present'|'changed'|'missing'|'unknown', why: string }}
 */
export function judge(id, ev, log) {
  const kind = kindOf(id), name = kind ? nameOf(id) : id;
  const hooks = ev.pack?.seams?.hooks ?? {};
  const stale = new Set(ev.stale ?? []);
  switch (kind) {
    case 'protocol': {
      const ref = log?.reference?.protocol?.[name];
      if (ev.report?.protocol?.regenerated === false || stale.has('census')) return { status: 'unknown', why: 'the protocol catalog was not regenerated for this build' };
      const schema = family(ev, 'protocol.schema');
      if (schema) {
        const cat = CATEGORIES.find((c) => schema.fingerprints?.[`${c}:${name}`] !== undefined || schema.values?.includes(`${c}:${name}`));
        if (cat) {
          const fp = schema.fingerprints?.[`${cat}:${name}`];
          if (fp && ref?.fp?.length && !ref.fp.includes(fp)) return { status: 'changed', why: 'its parameters or result changed in this build' };
          return { status: 'present', why: 'in this build\'s schema' };
        }
        if (family(ev, 'protocol.wireOnly')?.values?.includes(name)) return { status: 'present', why: 'among this build\'s wire-only methods' };
        if (ref?.in === 'schema') return { status: 'missing', why: 'it is not in this build\'s schema' };
        return { status: 'unknown', why: 'not found in this build (a method outside the schema is not always seen)' };
      }
      const m = ev.pack?.protocol?.methods ?? {};
      if (Object.values(m).some((l) => Array.isArray(l) && l.includes(name))) return { status: 'present', why: 'in this build\'s pack' };
      return { status: 'unknown', why: 'this build has no census of its protocol' };
    }
    case 'service': case 'message': case 'fromView': case 'command': case 'route': case 'state': {
      if (stale.has('census')) return { status: 'unknown', why: 'this build\'s census belongs to another build' };
      const spec = FAMILIES[kind];
      const fams = spec.ids.map((f) => family(ev, f));
      if (!fams.some(Boolean)) return { status: 'unknown', why: ev.facts ? 'its census family did not run' : 'this build has no census' };
      const has = (f) => f && (kind === 'route' && name.endsWith('/') ? f.values.some((v) => v.startsWith(name)) : f.values.includes(name));
      if (fams.some(has)) return { status: 'present', why: 'in this build\'s census' };
      if (fams.every((f) => f && spec.complete(f))) return { status: 'missing', why: 'it is not in this build' };
      return { status: 'unknown', why: 'not found, and this build\'s census of it is incomplete' };
    }
    case 'seam': {
      const v = hooks[name];
      if (SEAMS.has(name) && (Array.isArray(v) ? v.length : v)) return { status: 'present', why: 'the copy delivers it' };
      return { status: 'unknown', why: 'the copy\'s pack does not deliver it' };
    }
    case 'exposure': {
      if (hooks.exposures?.[name]) return { status: 'present', why: 'the copy exposes it' };
      // a member its namespace's locator requires (the log's `via`): there wherever the namespace is
      const via = log?.mechanics?.[id]?.via;
      if (typeof via === 'string' && via !== id) { const j = judge(via, ev, log); return j.status === 'present' ? { status: 'present', why: 'the copy exposes its namespace' } : j; }
      return { status: 'unknown', why: 'the copy\'s pack could not locate it' };
    }
    case 'binding': {
      const live = ev.live?.bindings?.[name];
      if (live?.state === 'tripped') return { status: 'changed', why: `its canary tripped${live.why ? `: ${live.why}` : ''}` };
      const needs = log?.mechanics?.[id]?.needs ?? [];
      const lacking = needs.find((m) => judge(m, ev, log).status !== 'present');
      if (lacking) return { status: 'unknown', why: `the copy does not deliver ${nameOf(lacking)}` };
      if (live?.state === 'works') return { status: 'present', why: 'a window saw it' };
      const b = family(ev, 'bindings.sites');
      if (!b || stale.has('census') || (ev.addressesSha256 && b.addressesSha256 !== ev.addressesSha256)) {
        return { status: 'unknown', why: b ? 'this build\'s binding census ran with other addresses' : 'this build has no binding census' };
      }
      const s = b.sites?.[name];
      if (!s) return keyless(log, id) ? { status: 'present', why: 'the copy exposes its component' } : { status: 'unknown', why: 'not in this build\'s binding census' };
      const strength = s.jsx ? 'jsx' : s.objects ? 'objects' : null;
      if (strength === 'jsx' || (strength === 'objects' && log?.reference?.bindings?.[name] === 'objects')) return { status: 'present', why: 'its address is in this build' };
      return { status: 'unknown', why: strength ? 'its address is found only indirectly in this build' : 'its address is not found in this build' };
    }
    case 'anchor': {
      if (!ev.pack?.anchors?.[name]) return { status: 'missing', why: 'this build\'s pack has no such anchor' };
      if (ev.live?.anchors?.includes(name)) return { status: 'present', why: 'a window saw it' };
      if (!stale.has('report') && ev.report?.anchors?.[name]?.selectors?.some((s) => s.status === 'found' || s.status === 'verified')) return { status: 'present', why: 'its selectors were found in this build' };
      return { status: 'unknown', why: 'its selectors were not verified in this build' };
    }
    default: return { status: 'unknown', why: 'not something this framework can check' };
  }
}
/** A binding addressed by an exposure (its component's identity), not by prop keys: the exposure is its evidence. */
const keyless = (log, id) => log?.mechanics?.[id]?.keyless === true;

/**
 * Every mechanic and feature of the log on one build.
 * @returns {{ mechanics: Record<string, {status: string, why: string}>, features: Record<string, {status: string, because: object[]}>,
 *   status: (id: string) => {status: string, because: object[], why?: string} }}
 */
export function evaluate(log, ev) {
  const mechanics = {};
  const judged = (id) => (mechanics[id] ??= judge(id, ev, log));
  const features = {};
  const visiting = new Set();
  function feature(id) {
    if (features[id]) return features[id];
    const f = log?.features?.[id];
    if (!f) return { status: 'unknown', because: [{ id, status: 'unknown', why: 'this framework does not know it' }] };
    if (visiting.has(id)) return { status: 'present', because: [] };
    visiting.add(id);
    let status = 'present'; const because = [];
    const note = (x, s) => { if (RANK[s.status] > RANK[status]) { status = s.status; because.length = 0; } if (RANK[s.status] === RANK[status] && s.status !== 'present') because.push({ id: x, status: s.status, why: s.why, ...(s.cause ? { cause: s.cause } : {}) }); };
    const one = (x) => (log.features[x] ? (() => { const r = feature(x); return { status: r.status, why: r.because[0]?.why ?? '', cause: r.because[0] }; })() : judged(x));
    for (const x of f.needs ?? []) {
      if (typeof x === 'string') { note(x, one(x)); continue; }
      const options = (x.anyOf ?? []).map((m) => [m, one(m)]);
      const pick = options.reduce((acc, o) => (!acc || RANK[o[1].status] < RANK[acc[1].status] ? o : acc), null);
      if (pick) note(pick[0], pick[1]);
    }
    if (f.realizedBy?.length) {
      const r = f.realizedBy.map((x) => [x, feature(x)]).reduce((acc, o) => (!acc || RANK[o[1].status] < RANK[acc[1].status] ? o : acc), null);
      if (r) note(r[0], { status: r[1].status, why: r[1].because[0]?.why ?? '', cause: r[1].because[0] });
    }
    visiting.delete(id);
    return (features[id] = { status, because });
  }
  for (const id of Object.keys(log?.mechanics ?? {})) judged(id);
  for (const id of Object.keys(log?.features ?? {})) feature(id);
  return {
    mechanics, features,
    /** A feature's or a mechanic's status, by id (any mechanic id is judged by its kind). */
    status: (id) => (log?.features?.[id] ? feature(id) : kindOf(id) && kindOf(id) !== 'graph' && kindOf(id) !== 'presentation' && kindOf(id) !== 'slot' && kindOf(id) !== 'sdk'
      ? (() => { const j = judged(id); return { status: j.status, because: j.status === 'present' ? [] : [{ id, status: j.status, why: j.why }] }; })()
      : feature(id)),
  };
}

/** The deepest mechanic behind a feature's status: what the sentence names. */
export function causeOf(r) {
  let c = r?.because?.[0];
  while (c?.cause) c = c.cause;
  return c ?? null;
}

/** Two builds' census facts, per family: the values that appeared and that disappeared, and whether the family's digest changed. */
export function diffFacts(a, b) {
  const out = {};
  const ids = new Set([...Object.keys(a?.families ?? {}), ...Object.keys(b?.families ?? {})]);
  for (const id of [...ids].sort()) {
    const x = a?.families?.[id], y = b?.families?.[id];
    if (x?.status !== 'ok' || y?.status !== 'ok') { out[id] = { unknown: true, ...(x?.status !== 'ok' ? { before: x?.status ?? 'absent' } : {}), ...(y?.status !== 'ok' ? { after: y?.status ?? 'absent' } : {}) }; continue; }
    if (x.digestSha256 === y.digestSha256 && JSON.stringify(x.fingerprints ?? null) === JSON.stringify(y.fingerprints ?? null) && JSON.stringify(x.sites ?? null) === JSON.stringify(y.sites ?? null)) continue;
    const before = new Set(x.values ?? []), after = new Set(y.values ?? []);
    const d = { appeared: [...after].filter((v) => !before.has(v)).sort(), disappeared: [...before].filter((v) => !after.has(v)).sort() };
    if (x.fingerprints || y.fingerprints) {
      const changed = Object.keys(y.fingerprints ?? {}).filter((k) => x.fingerprints?.[k] !== undefined && x.fingerprints[k] !== y.fingerprints[k]).sort();
      if (changed.length) d.changed = changed;
    }
    if (x.sites || y.sites) {
      const moved = Object.keys({ ...(x.sites ?? {}), ...(y.sites ?? {}) }).filter((k) => JSON.stringify(x.sites?.[k]) !== JSON.stringify(y.sites?.[k])).sort();
      if (moved.length) d.sites = moved;
    }
    out[id] = d;
  }
  return out;
}

/** What differs between two builds' results (`evaluate`): per mechanic and feature, the status and its reason, so a new reason shows
 *  even where the status stays the same. */
export function affected(a, b) {
  const out = [];
  for (const key of ['mechanics', 'features']) {
    const ids = new Set([...Object.keys(a?.[key] ?? {}), ...Object.keys(b?.[key] ?? {})]);
    for (const id of [...ids].sort()) {
      const x = a?.[key]?.[id], y = b?.[key]?.[id];
      const why = (r) => (key === 'mechanics' ? r?.why : JSON.stringify(r?.because ?? []));
      if (x?.status === y?.status && why(x) === why(y)) continue;
      out.push({ id, from: x?.status ?? null, to: y?.status ?? null, ...(key === 'mechanics' ? { why: y?.why ?? null } : { because: y?.because ?? [] }) });
    }
  }
  return out;
}

/**
 * The live windows' reports merged: a binding tripped in any live window of its current page generation wins over another's success;
 * one that works anywhere else is seen; an anchor seen anywhere is seen.
 * @param {Iterable<{ bindings?: Record<string, {state: string, why?: string}>, anchors?: string[] }>} reports  one per live window (its latest)
 */
export function mergeLive(reports) {
  const bindings = {}, anchors = new Set();
  for (const r of reports) {
    for (const [id, b] of Object.entries(r?.bindings ?? {})) {
      const cur = bindings[id];
      if (b?.state === 'tripped') bindings[id] = { state: 'tripped', ...(b.why ? { why: String(b.why) } : {}) };
      else if (b?.state === 'works' && cur?.state !== 'tripped') bindings[id] = { state: 'works' };
      else if (!cur) bindings[id] = { state: 'unseen' };
    }
    for (const a of r?.anchors ?? []) anchors.add(a);
  }
  return { bindings, anchors: [...anchors].sort() };
}

/** The live evidence in the Host's probe state (`framework/probe`): the anchors a window saw and each binding's merged state. */
export function liveOfProbe(p) {
  const items = p?.items ?? {};
  return { bindings: p?.bindings ?? {}, anchors: Object.keys(items).filter((k) => k.startsWith('anchor:') && items[k] === true).map((k) => k.slice(7)).sort() };
}

/** A mechanic's title, in plain words. */
export function titleOf(id) {
  if (typeof id !== 'string' || id.indexOf(':') < 0) return String(id);
  const i = id.indexOf(':'); const kind = id.slice(0, i), name = id.slice(i + 1);
  switch (kind) {
    case 'protocol': return `the app-server method ${name}`;
    case 'service': return `the app's ${name} service`;
    case 'message': return `the app's page message ${name}`;
    case 'fromView': return `the app's main's message ${name} (sent by a page)`;
    case 'command': return `the app's command ${name}`;
    case 'route': return `the app's page ${name}`;
    case 'state': return `the app's stored ${name}`;
    case 'seam': return `the ${name} seam of the copy`;
    case 'exposure': return `the app's ${name} (as the copy exposes it)`;
    case 'binding': return `the app's component the ${name} binding names`;
    case 'anchor': return `the ${name} anchor`;
    default: return id;
  }
}
