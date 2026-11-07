#!/usr/bin/env node
// The round-trip axis of the coverage ledger (docs/design/graph-integrity.md G9.2): docs/coverage/roundtrip.json, each shared
// surface's rows by concept and each lent part's row, checked natively through a mod's path (qa.conformance).
//   node scripts/roundtrip.mjs          the report
//   node scripts/roundtrip.mjs --check  exit 1 when the ledger disagrees with the lent parts or the conformance mod, or a row is malformed
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATUSES = new Set(['open', 'green', 'none']);

export const ledger = (root = ROOT) => JSON.parse(readFileSync(join(root, 'docs/coverage/roundtrip.json'), 'utf8'));
/** The lent parts the framework offers (framework/renderer/present/lent/index.mjs LENT_NAMES), read from its source. */
export function lentNames(root = ROOT) {
  const src = readFileSync(join(root, 'framework/renderer/present/lent/index.mjs'), 'utf8');
  const m = /export const LENT_NAMES = Object\.freeze\(\[([^\]]*)\]\)/.exec(src);
  return m ? [...m[1].matchAll(/'([A-Za-z]+)'/g)].map((x) => x[1]) : [];
}
/** The concepts the conformance mod gives its own kind of (its TYPES: `sub('Conf<X>', '<Concept>')`), but its own step kind. */
export function conformanceConcepts(root = ROOT) {
  const src = readFileSync(join(root, 'scripts/qa/mods/qa.conformance/host.mjs'), 'utf8');
  return [...src.matchAll(/sub\('Conf[A-Za-z]+', '([A-Za-z]+)'/g)].map((x) => x[1]).filter((c) => c !== 'Step');
}
/** Every row: [where, name, row]. */
export function rows(l = ledger()) {
  const out = [];
  for (const [surface, s] of Object.entries(l.surfaces ?? {})) for (const [concept, row] of Object.entries(s.rows ?? {})) out.push([`surfaces.${surface}`, concept, row]);
  for (const [part, row] of Object.entries(l.lentParts ?? {})) out.push(['lentParts', part, row]);
  return out;
}
/** What disagrees: a lent part with no row (or a row for none), a conformance concept no surface shows, a malformed row. */
export function problems(root = ROOT) {
  const l = ledger(root), out = [];
  const lent = lentNames(root);
  for (const p of lent) if (!l.lentParts?.[p]) out.push(`lentParts.${p}: no row`);
  for (const p of Object.keys(l.lentParts ?? {})) if (!lent.includes(p)) out.push(`lentParts.${p}: not a lent part`);
  const shown = new Set(Object.values(l.surfaces ?? {}).flatMap((s) => Object.keys(s.rows ?? {})));
  for (const c of conformanceConcepts(root)) if (!shown.has(c)) out.push(`${c}: the conformance mod gives one, and no surface's rows check it`);
  for (const [surface, s] of Object.entries(l.surfaces ?? {})) if (typeof s.what !== 'string' || !s.what) out.push(`surfaces.${surface}: says what it does`);
  for (const [where, name, row] of rows(l)) {
    const at = `${where}.${name}`;
    if (!STATUSES.has(row?.status)) { out.push(`${at}: status is open, green or none`); continue; }
    if (row.status === 'green') {
      if (!/^\d+\.\d+\.\d+-\d+$/.test(row.build ?? '')) out.push(`${at}: a green row names its build`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date ?? '')) out.push(`${at}: a green row has its date`);
      const file = typeof row.proof === 'string' ? row.proof.split('#')[0] : '';
      // a file of this checkout, or (`history:<path>`) one of the design history that a published tree leaves out
      if (!file || (!file.startsWith('history:') && !existsSync(join(root, file)))) out.push(`${at}: a green row's proof is a file in this repository`);
    }
    if (row.status === 'none' && (typeof row.why !== 'string' || !row.why)) out.push(`${at}: a row the surface does not show says why`);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const l = ledger();
  const all = rows(l);
  if (process.argv.includes('--check')) {
    const p = problems();
    for (const x of p) console.log(x);
    process.exit(p.length ? 1 : 0);
  }
  for (const [where, name, row] of all) console.log(`${where.padEnd(24)} ${name.padEnd(22)} ${row.status}${row.build ? `  ${row.build} ${row.date}` : ''}${row.why ? `  (${row.why})` : ''}`);
  const by = (s) => all.filter((x) => x[2].status === s).length;
  console.log(`\n${all.length} rows: ${by('green')} green, ${by('open')} open, ${by('none')} not shown there`);
}
