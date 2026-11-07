'use strict';
// "Always allow this server" (ARCHITECTURE v1.19): the trusted fingerprints in profile.json `guardTrusted[]`.
// A fingerprint is the executable path plus argv of a conflicting Codex app-server (never the pid). The loader appends entries when
// the owner picks the third button; this module is the management side, for the CLI (`codexmods recovery guard list|untrust <n>`).
// Plain CommonJS with no dependencies besides fsx.cjs, so ESM code can `createRequire(import.meta.url)('…/framework/main/guard-trust.cjs')`.
const { readJsonSync, writeJsonSync } = require('./fsx.cjs');

/** @param {string} profileFile layout.profileConfig @returns {string[]} the trusted fingerprints, in stored order (display index n = position + 1) */
function listTrusted(profileFile) {
  const p = readJsonSync(profileFile, null);
  return p && Array.isArray(p.guardTrusted) ? p.guardTrusted.filter((f) => typeof f === 'string') : [];
}

/** Appends fingerprints that are not yet trusted. Every other profile.json field is kept. @returns {string[]} the new list */
function trust(profileFile, fingerprints) {
  const p = readJsonSync(profileFile, null);
  if (!p || typeof p !== 'object') throw new Error(`cannot read ${profileFile}`);
  const list = listTrusted(profileFile);
  for (const f of fingerprints) if (typeof f === 'string' && f && !list.includes(f)) list.push(f);
  writeJsonSync(profileFile, { ...p, guardTrusted: list });
  return list;
}

/** Removes the n-th entry as shown by list (1-based). @returns {string} the removed fingerprint. Throws RangeError for a bad n. */
function untrust(profileFile, n) {
  const p = readJsonSync(profileFile, null);
  if (!p || typeof p !== 'object') throw new Error(`cannot read ${profileFile}`);
  const list = listTrusted(profileFile);
  const i = Number(n);
  if (!Number.isInteger(i) || i < 1 || i > list.length) throw new RangeError(`no trusted entry ${n} (there are ${list.length})`);
  const [removed] = list.splice(i - 1, 1);
  writeJsonSync(profileFile, { ...p, guardTrusted: list });
  return removed;
}

module.exports = { listTrusted, trust, untrust };
