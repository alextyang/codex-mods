// A mod's automatic actions as the user turned them on (docs/design/public-hooks.md §3.9): the record keeps each one as it was declared when
// the user turned it on, so a version that declares it differently (another operation, other bounds, another rate) has it off again.
// Node built-ins only (none needed).

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** JSON with sorted keys: two declarations that say the same are the same. */
const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(',')}]` : isObj(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v));

/** Whether two declarations of an automatic action say the same. */
export const sameAction = (a, b) => isObj(a) && isObj(b) && stable(a) === stable(b);

/** An update or a rollback keeps an action the user turned on only while the new version declares it the same. */
export function keepAutomatic(record, manifest) {
  if (!record.automatic) return;
  const declared = new Map((manifest?.automatic ?? []).map((a) => [a.id, a]));
  for (const [id, decl] of Object.entries(record.automatic)) if (!sameAction(declared.get(id), decl)) delete record.automatic[id];
  if (!Object.keys(record.automatic).length) delete record.automatic;
}

/** The actions a mod declares, each with whether it is on: the mod is on and the user turned on this very declaration. */
export function automaticOf(record, manifest) {
  return (manifest?.automatic ?? []).map((a) => ({ ...a, on: record?.status === 'enabled' && sameAction(record.automatic?.[a.id], a) }));
}
