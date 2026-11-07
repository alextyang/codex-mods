// An update's plan (docs/design/systems.md S19, S20, "E5 in detail"): the immutable record staging writes last, and what applying it
// needs from it. A plan:
//   { plan: 1, hash, createdAt, offer: { build, framework?, mods },
//     stock: { build, snapshot, plist, executable, asar }, pack: { build, from, adapter, facts },
//     candidate: { path, inputsHash }, framework: null | { from, to, treeHash, dir },
//     enabled: [{ id, version, current: { status, reasons }, incoming?: { version, package, sha256, addedPermissions, status, reasons, github? } }],
//     display: [{ id, version, on, now, verdict, unknown, tested, uses: [{ id, title }], changed: [id], missing: [id], unchecked: [id], candidate?: { version, verdict, addedPermissions, from } }] }
// (`display`: every installed mod as the Update page shows it, F11; derived, so not an input of the hash)
// `hash` is over the inputs (everything but `createdAt` and the statuses), so any changed input is a new plan. Which version each enabled
// mod runs follows from the plan and the user's consent: its incoming one when that is no worse on the candidate than its current one and,
// when it adds permissions, the user consented; else its current one. The verdict is held when any of them is at risk or blocked there.
// Node built-ins only.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CodexModsError } from '../../../sdk/errors.mjs';

const RANK = { compatible: 0, degraded: 1, atRisk: 2, blocked: 3 };
const HELD = new Set(['atRisk', 'blocked']);

export const planDir = (layout, hash) => join(layout.profileUpdates, hash);
export const planFile = (layout, hash) => join(planDir(layout, hash), 'plan.json');

/** The canonical JSON of a value (keys sorted), for hashing. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
/** A plan's hash: its inputs, without when it was made or what the mods' compatibility was found to be. */
export function planHashOf(plan) {
  const inputs = { ...plan, hash: undefined, createdAt: undefined, display: undefined,
    enabled: (plan.enabled ?? []).map((m) => ({ id: m.id, version: m.version, ...(m.incoming ? { incoming: { version: m.incoming.version, sha256: m.incoming.sha256, addedPermissions: m.incoming.addedPermissions } } : {}) })) };
  return createHash('sha256').update(canonical(inputs)).digest('hex').slice(0, 32);
}

export async function readPlan(layout, hash) {
  if (typeof hash !== 'string' || !/^[0-9a-f]{32}$/.test(hash)) throw new CodexModsError('Invalid', 'plan must be a plan\'s hash');
  let plan;
  try { plan = JSON.parse(await readFile(planFile(layout, hash), 'utf8')); } catch { throw new CodexModsError('Unavailable', `no plan ${hash}: stage the update again`); }
  if (plan?.hash !== hash || planHashOf(plan) !== hash) throw new CodexModsError('Invalid', `the plan ${hash} does not match its record`);
  return plan;
}

/**
 * Each enabled mod's version on the candidate, given the user's consent.
 * @returns {{ id: string, from: string, to: string, takes: boolean, status: string, reasons: object[], why?: string }[]}
 */
export function choose(plan, consent = []) {
  return (plan.enabled ?? []).map((m) => {
    const inc = m.incoming;
    const keep = (why) => ({ id: m.id, from: m.version, to: m.version, takes: false, status: m.current.status, reasons: m.current.reasons ?? [], ...(why ? { why } : {}) });
    if (!inc) return keep();
    if (RANK[inc.status] > RANK[m.current.status]) return keep(`${inc.version} would be ${inc.status} on the new build; ${m.version} stays`);
    if (inc.addedPermissions?.length && !consent.includes(m.id)) return keep(`${inc.version} asks for new permissions (${inc.addedPermissions.join(', ')}); ${m.version} stays without consent`);
    return { id: m.id, from: m.version, to: inc.version, takes: true, status: inc.status, reasons: inc.reasons ?? [] };
  });
}

/** The verdict for a choice: held with its risks (one per mod at risk or blocked on the candidate), or ready. */
export function verdictOf(chosen) {
  const risks = chosen.filter((c) => HELD.has(c.status)).map((c) => ({ mod: c.id, status: c.status, sentences: (c.reasons ?? []).filter((r) => r.required).map((r) => r.sentence),
    features: (c.reasons ?? []).filter((r) => r.required).map((r) => r.id) }));
  return { held: risks.length > 0, risks };
}

/**
 * The plan's inputs read again (phase `recheck`): refused as Stale when the candidate, the staged framework, an incoming package or the
 * enabled mods are not what the plan recorded.
 * @param {{ state: object, buildReport: (candidatePath: string) => Promise<object|null>, sha256: (file: string) => Promise<string|null>,
 *   exists: (path: string) => Promise<boolean> }} io
 */
export async function recheck(plan, io) {
  const stale = (why) => { throw new CodexModsError('Conflict', `the update's plan is stale: ${why}; stage it again`, { stale: true }); };
  if (!(await io.exists(plan.candidate.path))) stale('its candidate copy is gone');
  const report = await io.buildReport(plan.candidate.path);
  if (report?.inputsHash !== plan.candidate.inputsHash) stale('its candidate copy was built from other inputs');
  if (plan.framework && !(await io.exists(plan.framework.dir))) stale(`the staged framework ${plan.framework.to} is gone`);
  const enabledNow = Object.values(io.state.mods).filter((r) => r.status === 'enabled').map((r) => `${r.id}@${r.version}`).sort();
  const enabledThen = (plan.enabled ?? []).map((m) => `${m.id}@${m.version}`).sort();
  if (enabledNow.join(',') !== enabledThen.join(',')) stale('the enabled mods changed');
  for (const m of plan.enabled ?? []) {
    if (m.incoming && (await io.sha256(m.incoming.package)) !== m.incoming.sha256) stale(`the package of ${m.id} ${m.incoming.version} changed`);
  }
}
