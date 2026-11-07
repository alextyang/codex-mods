#!/usr/bin/env node
// Cross-check of the object graph plan in docs/graph/ (06-review.md, "Cross-check"). Usage: node scripts/graph-check.mjs [dir]
// Checks that features (01), type cards (02, and the framework's in 07), presentation cards (03) and the overview diagrams (05) name each
// other consistently.
// It also checks that the realization map (docs/design/realization/README.md, sections 3 and 4) has a row for every type and presentation type.
// It reads Markdown only and changes nothing. Exit 1 when it finds a problem.
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GRAPH_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'graph');
export const REALIZATION = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'design', 'realization', 'README.md');

/** Shared values that cards use without a card of their own (02, intro). */
const VALUES = new Set(['Ref', 'Time', 'Duration', 'Path', 'Url', 'Image', 'Color', 'Outcome', 'Content', 'Window']);

export const withoutExamples = (text) => text.replace(/```(?!mermaid)[\s\S]*?```/g, '');
export const withoutQuotes = (text) => text.replace(/"[^"]*"/g, '');
const names = (text, re = /\b[A-Z]\w+/g) => text.match(re) ?? [];

/** Cards of a file as { name: { field: text } }, with continuation lines folded into their field. */
export function cards(text, headerRe) {
  const out = new Map();
  for (const block of text.split(/^(?=## )/m)) {
    const m = block.match(headerRe);
    if (!m) continue;
    const fields = {};
    let current = null;
    for (const line of block.split('\n').slice(1)) {
      const f = line.match(/^([A-Z][a-z]+) {2,}(.*)$/);
      if (f) { current = f[1]; fields[current] = f[2]; }
      else if (current && line.startsWith('            ')) fields[current] += ` ${line.trim()}`;
      else current = null;
    }
    out.set(m[1], { kind: m[2], fields });
  }
  return out;
}

/** Names in the first column of the body rows of the realization map's type and presentation tables (sections 3 and 4). */
function realizedNames(text) {
  const out = new Set();
  const body = text.split(/^## (?=\d)/m).filter((s) => /^[34]\./.test(s)).join('\n');
  const rows = body.split('\n');
  rows.forEach((row, i) => {
    if (!row.startsWith('|') || row.startsWith('|---') || rows[i + 1]?.startsWith('|---')) return;
    for (const n of names(row.split('|')[1])) out.add(n);
  });
  return out;
}

export function checkGraph(dir = GRAPH_DIR, realization = REALIZATION) {
  const read = (f) => readFileSync(join(dir, f), 'utf8');
  // The framework's own types (07) are cards like 02's, with their features in 01's form.
  const f07 = existsSync(join(dir, '07-framework.md')) ? withoutExamples(read('07-framework.md')) : '';
  const f01 = `${read('01-features.md')}\n${f07}`;
  const f02 = `${withoutExamples(read('02-types.md'))}\n${f07}`;
  const f03 = withoutExamples(read('03-presentations.md'));
  const f05 = read('05-graph.md');
  const types = cards(f02, /^## (\w+) {2,}(concept|subtype|value)/);
  const pres = cards(f03, /^## (\w+) {2,}(presentation|concept)/);
  const problems = [];

  // 01: every row's types and presentations.
  const f01Types = new Set();
  const f01Pres = new Set();
  for (const [, feature, ts, ps] of f01.matchAll(/^\|(?!---)(.+)\|(.+)\|(.+)\|$/gm)) {
    if (feature.trim() === 'Feature') continue;
    for (const t of names(ts)) f01Types.add(t);
    for (const p of names(ps)) f01Pres.add(p);
  }
  for (const t of types.keys()) if (!f01Types.has(t)) problems.push(`type card not in 01: ${t}`);
  for (const t of f01Types) if (!types.has(t)) problems.push(`01 names unknown type: ${t}`);
  for (const p of f01Pres) if (!pres.has(p)) problems.push(`01 names unknown presentation: ${p}`);

  // 02: presentations, relation targets, subtype lists.
  const usedPres = new Set(f01Pres);
  for (const [name, { fields }] of types) {
    for (const item of (fields.Presented ?? '').split('·')) {
      const m = item.match(/^\s*([A-Z]\w+)/);
      if (!m) continue;
      usedPres.add(m[1]);
      if (!pres.has(m[1])) problems.push(`02 ${name}: unknown presentation ${m[1]}`);
    }
    for (const [, target] of (fields.Relations ?? '').matchAll(/:\s*([A-Z]\w+)(?=[\s|(])/g)) {
      if (!types.has(target) && !pres.has(target) && !VALUES.has(target)) problems.push(`02 ${name}: relation to unknown type ${target}`);
    }
    const listed = (fields.Extends ?? '').match(/Subtypes: ([^;]+)/);
    for (const st of listed ? names(listed[1]) : []) {
      if (!types.has(st)) problems.push(`02 ${name}: unknown subtype ${st}`);
      else if (types.get(st).kind !== 'subtype') problems.push(`02 ${name}: ${st} listed as subtype but carded as ${types.get(st).kind}`);
    }
  }
  for (const [, st, parent] of f02.matchAll(/^## (\w+) {2,}subtype of (\w+)/gm)) {
    if (!types.has(parent)) { problems.push(`02 ${st}: parent ${parent} unknown`); continue; }
    const { fields } = types.get(parent);
    if (!names(`${fields.Extends ?? ''} ${fields.Subtypes ?? ''}`).includes(st)) problems.push(`02 ${parent} does not list subtype ${st}`);
  }

  // 03: what each presentation presents, where it sits and what it contains.
  for (const [name, { fields }] of pres) {
    for (const t of names(withoutQuotes(fields.Presents ?? ''), /\b[A-Z][a-z]+[A-Z]?\w*/g)) {
      if (!types.has(t) && !pres.has(t)) problems.push(`03 ${name}: presents unknown ${t}`);
    }
    for (const key of ['In', 'Contains']) {
      for (const t of names(fields[key] ?? '')) {
        if (key === 'Contains' && types.has(t) && !pres.has(t)) problems.push(`03 ${name}: contains non-presentation ${t}`);
        else if (!types.has(t) && !pres.has(t)) problems.push(`03 ${name}: ${key} names unknown ${t}`);
      }
    }
  }

  // 05: every diagram node has a card; Mod… nodes stand for mod-defined subtypes.
  const diagrams = [...f05.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
  for (const node of new Set(names(diagrams, /\b[A-Z]\w+\b/g))) {
    if (!types.has(node) && !pres.has(node) && !node.startsWith('Mod') && node !== 'Any' && node !== 'LR') problems.push(`05 names unknown ${node}`);
  }

  // Realization map: a row for every type and presentation type, and no row for anything else.
  // the realization map is a design note: a published tree that leaves the design notes out has none to check
  if (existsSync(realization)) {
    const realized = realizedNames(readFileSync(realization, 'utf8'));
    for (const t of [...types.keys(), ...pres.keys()]) if (t !== 'Presentation' && !realized.has(t)) problems.push(`realization has no row for ${t}`);
    for (const t of realized) if (!types.has(t) && !pres.has(t)) problems.push(`realization names unknown ${t}`);
  }

  const count = (kind) => [...types.values()].filter((c) => c.kind === kind).length;
  return {
    types: { total: types.size, concepts: count('concept'), subtypes: count('subtype'), values: count('value') },
    presentations: [...pres.values()].filter((c) => c.kind === 'presentation').length,
    unusedPresentations: [...pres.keys()].filter((p) => p !== 'Presentation' && !usedPres.has(p)),
    problems,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = checkGraph(process.argv[2] ?? GRAPH_DIR);
  const { total, concepts, subtypes, values } = r.types;
  process.stdout.write(`types: ${total} (${concepts} concepts, ${subtypes} subtypes, ${values} values)\n`);
  process.stdout.write(`presentation types: ${r.presentations} (+ the Presentation concept)\n`);
  process.stdout.write(`presentations not named by 01 or 02: ${r.unusedPresentations.join(', ') || 'none'}\n`);
  process.stdout.write(`problems: ${r.problems.length}\n${r.problems.map((p) => `  ${p}\n`).join('')}`);
  process.exitCode = r.problems.length ? 1 : 0;
}
