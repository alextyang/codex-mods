// Compatibility (ARCHITECTURE §15, docs/design/systems.md S18, "E4 in detail"): what a mod needs, against a build's status in the
// feature log. One evaluator for the running copy, a prepared candidate and the CLI. A mod needs the features it names in `requires` and
// `optional` (`features`: ids, or {id, version}), its other lists read as mechanics (methods as `protocol:`, components as SDK features,
// `sdk:component.<Name>`), and, as optional hints, what its typed graph grants show it
// uses. A required feature missing is blocked; changed or unknown, at risk; an optional one missing, changed or unknown, degraded. Each
// reason is one sentence naming the feature and what changed.

import { RANK, causeOf, titleOf as mechanicTitle } from '../features/status.mjs';
import { NATIVE_TYPES } from '../../../sdk/graph/native/index.mjs';

const PARENT = new Map(NATIVE_TYPES.map((t) => [t.id, typeof t.parent === 'string' ? t.parent : t.parent?.id ?? null]));
/** A grant may name an operation on a subtype (`graph.act:CodexThread.send`); the log has it where it is declared (`graph:Thread.send`). */
function loggedAs(log, id) {
  const m = log?.features && !log.features[id] ? /^graph:([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)$/.exec(id) : null;
  if (!m) return id;
  for (let t = PARENT.get(m[1]); t; t = PARENT.get(t)) if (log.features[`graph:${t}.${m[2]}`]) return `graph:${t}.${m[2]}`;
  return id;
}

const GRANT_KINDS = { 'graph.read': 'graph', 'graph.act': 'graph', 'graph.intercept': 'graph', 'graph.present': 'presentation' };

/**
 * What a mod needs: `required` and `optional`, each [{ id, version }] (a mod's own declarations win over its grants' hints).
 * @param {import('../../../contracts/manifest.js').ModManifest} manifest
 */
export function requirementsOf(manifest) {
  const required = new Map(), optional = new Map();
  const add = (into, id, version = 1) => { if (!required.has(id) && !into.has(id)) into.set(id, { id, version }); };
  const lists = (section, into) => {
    for (const m of section?.methods ?? []) add(into, `protocol:${m}`);
    for (const c of section?.components ?? []) add(into, `sdk:component.${c}`);
    for (const f of section?.features ?? []) {
      if (typeof f === 'string') add(into, f);
      else if (f && typeof f.id === 'string') add(into, f.id, Number.isInteger(f.version) ? f.version : 1);
    }
  };
  lists(manifest?.requires, required);
  lists(manifest?.optional, optional);
  for (const p of manifest?.permissions ?? []) {
    if (typeof p !== 'string') continue;
    const i = p.indexOf(':');
    const kind = GRANT_KINDS[i < 0 ? p : p.slice(0, i)];
    if (!kind || i < 0) continue;
    for (const t of p.slice(i + 1).split(',').map((s) => s.trim()).filter(Boolean)) if (t !== '*') add(optional, `${kind}:${t}`);
  }
  for (const id of required.keys()) optional.delete(id);
  return { required: [...required.values()], optional: [...optional.values()] };
}

/** A feature's or mechanic's title, as a sentence names it (the Update page's reasons too: F11). */
export const featureTitle = (log, id) => log?.features?.[id]?.title ?? log?.mechanics?.[id]?.title ?? (/^(graph|presentation|slot|sdk):/.test(id) ? id : mechanicTitle(id));
const titleOf = featureTitle;

/** The sentence for one requirement that is not met. */
function sentence(log, req, r, required) {
  const title = titleOf(log, req.id);
  if (r.version) return `It was written for version ${req.version} of ${title}; this framework has version ${r.version}.`;
  if (!log?.features?.[req.id] && !log?.mechanics?.[req.id] && /^(graph|presentation|slot|sdk):/.test(req.id)) {
    return required ? `It needs ${req.id}, which this framework does not know.` : `It can use ${req.id}, which this framework does not know.`;
  }
  const c = causeOf(r);
  const tail = c && c.id !== req.id ? `: ${titleOf(log, c.id)}${c.why ? ` (${c.why})` : ''}` : r.because?.[0]?.why ? ` (${r.because[0].why})` : '';
  const what = r.status === 'missing' ? 'which this build of the app lacks' : r.status === 'changed' ? 'which changed in this build of the app' : 'which could not be checked on this build of the app';
  return `${required ? 'It needs' : 'It works without'} ${title}, ${what}${tail}.`;
}

/**
 * @param {import('../../../contracts/manifest.js').ModManifest} manifest
 * @param {{ log: object|null, evaluation: { status: (id: string) => object } | null }} features  a build's evaluation (features/status.mjs)
 * @returns {import('../../../contracts/host.js').Compatibility}
 */
export function computeCompatibility(manifest, features) {
  const { required, optional } = requirementsOf(manifest);
  const log = features?.log ?? null;
  const ev = features?.evaluation ?? null;
  const reasons = [], missingRequired = [], missingOptional = [];
  let status = 'compatible';
  const judgeOne = (req) => {
    const f = log?.features?.[req.id];
    if (f && !(f.accepts ?? [f.version ?? 1]).includes(req.version)) return { status: 'missing', because: [], version: f.version ?? 1 };
    return ev ? ev.status(req.id) : { status: 'unknown', because: [{ id: req.id, status: 'unknown', why: 'this framework has no feature log' }] };
  };
  for (const [list, isRequired] of [[required, true], [optional, false]]) {
    for (const given of list) {
      const req = { ...given, id: loggedAs(log, given.id) };
      const r = judgeOne(req);
      if (r.status === 'present') continue;
      const s = isRequired ? (r.status === 'missing' ? 'blocked' : 'atRisk') : 'degraded';
      if (RANK_STATUS[s] > RANK_STATUS[status]) status = s;
      if (r.status === 'missing') (isRequired ? missingRequired : missingOptional).push(req.id);
      reasons.push({ id: req.id, title: titleOf(log, req.id), status: r.status, required: isRequired, sentence: sentence(log, req, r, isRequired) });
    }
  }
  return { status, missingRequired, missingOptional, reasons, features: [...required, ...optional].map((r) => r.id) };
}

/** Why a blocked mod cannot run: the sentences of its missing required features. */
export const blockedBecause = (c) => (c.reasons ?? []).filter((r) => r.required && r.status === 'missing').map((r) => r.sentence).join(' ')
  || `missing ${c.missingRequired.join(', ')}`;
/** The note an install gives a mod that runs with less: its sentences. */
export const noteOf = (c) => (c.status === 'atRisk' ? `At risk: ${(c.reasons ?? []).filter((r) => r.required).map((r) => r.sentence).join(' ')}`
  : c.status === 'degraded' ? `Degraded: ${(c.reasons ?? []).map((r) => r.sentence).join(' ') || `missing optional ${c.missingOptional.join(', ')}`}` : null);

/** The four answers, by severity: an overlay (a mod whose graph types lost their base) only ever raises one. */
export const RANK_STATUS = Object.freeze({ compatible: 0, degraded: 1, atRisk: 2, blocked: 3 });
export const atLeast = (status, floor) => (RANK_STATUS[floor] > RANK_STATUS[status] ? floor : status);
export { RANK };
