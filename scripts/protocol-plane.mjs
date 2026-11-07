#!/usr/bin/env node
// The protocol-plane report (docs/design/graph-integrity.md G8.1): every mod's appServer.* permissions, each with the graph gap that requires
// it and the part that closes it, or why the mod is low-level by intent. The ledger is docs/coverage/protocol-plane.json.
//   node scripts/protocol-plane.mjs          the report
//   node scripts/protocol-plane.mjs --check  exit 1 when a manifest and the ledger disagree
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Where mods live in this repository: the maintained mods, the QA mods, test fixtures and the SDK's starters. */
const PLACES = ['mods', 'scripts/qa/mods', 'tests/fixtures/mods', 'sdk/templates'];

/** Each mod's protocol-plane permissions, by kind: {modId: {kind: [the permission strings]}}, with where its manifest is. */
export function protocolUses(root = ROOT) {
  const out = {};
  for (const place of PLACES) {
    const dir = join(root, place);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const file = join(dir, name, 'mod.json');
      if (!existsSync(file)) continue;
      const m = JSON.parse(readFileSync(file, 'utf8'));
      for (const p of m.permissions ?? []) {
        if (typeof p !== 'string' || !p.startsWith('appServer.')) continue;
        const kind = p.split(':')[0];
        ((out[m.id] ??= { manifest: join(place, name, 'mod.json'), uses: {} }).uses[kind] ??= []).push(p);
      }
    }
  }
  return out;
}

export function ledger(root = ROOT) {
  return JSON.parse(readFileSync(join(root, 'docs/coverage/protocol-plane.json'), 'utf8')).mods;
}

/** What disagrees: a use the ledger lacks, a ledger entry no manifest has, an entry with neither a gap and its part nor a reason. */
export function problems(root = ROOT) {
  const uses = protocolUses(root), led = ledger(root), out = [];
  for (const [id, { manifest, uses: kinds }] of Object.entries(uses)) {
    for (const kind of Object.keys(kinds)) if (!led[id]?.[kind]) out.push(`${manifest}: ${kind} is not in the ledger`);
  }
  for (const [id, kinds] of Object.entries(led)) {
    for (const [kind, e] of Object.entries(kinds)) {
      if (!uses[id]?.uses[kind]) out.push(`ledger: ${id} ${kind} is used by no manifest`);
      const gap = typeof e.gap === 'string' && e.gap && typeof e.closedBy === 'string' && e.closedBy;
      const low = typeof e.lowLevel === 'string' && e.lowLevel;
      if (!gap === !low) out.push(`ledger: ${id} ${kind} needs either {gap, closedBy} or {lowLevel}`);
    }
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const uses = protocolUses(), led = ledger();
  for (const [id, { uses: kinds }] of Object.entries(uses).sort(([a], [b]) => a.localeCompare(b))) {
    for (const kind of Object.keys(kinds)) {
      const e = led[id]?.[kind];
      const why = !e ? 'NOT IN THE LEDGER' : e.lowLevel ? `low-level by intent: ${e.lowLevel}` : `${e.gap}; closed by ${e.closedBy}`;
      console.log(`${id}  ${kind}  ${why}`);
    }
  }
  const p = problems();
  for (const x of p) console.error(x);
  if (process.argv.includes('--check') && p.length) process.exit(1);
}
