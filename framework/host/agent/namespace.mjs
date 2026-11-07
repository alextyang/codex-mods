// The namespace of a mod's tools as the agent sees them (graph-integrity G3.5): `mod_` names are the framework's, each one a mod's, one to
// one, so the referee knows whose a tool is (only that mod adds it at a thread's start, and only that mod answers its calls). Node
// built-ins only.
import { createHash } from 'node:crypto';

export const PREFIX = 'mod_';
const MOD_ID = /^[a-z0-9.-]+$/;   // contracts/manifest.d.ts

/**
 * `mod_` and the mod's id with `.` as `_` (a mod id has no `_`), at most 63; a longer id (or one a manifest would refuse) is exactly 64: the
 * start of that, `_`, and 80 bits of a hash of the whole id.
 */
export function namespaceOf(modId) {
  const id = String(modId), ns = `${PREFIX}${id.replace(/[^A-Za-z0-9-]/g, '_')}`;
  if (MOD_ID.test(id) && ns.length <= 63) return ns;
  return `${ns.slice(0, 43).padEnd(43, '_')}_${createHash('sha256').update(id).digest('hex').slice(0, 20)}`;
}
