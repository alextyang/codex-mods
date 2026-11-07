#!/usr/bin/env node
// Coverage of the object graph (docs/design/release-2.md §5, docs/design/breadth.md §3). Usage: node scripts/coverage.mjs [--json]
// Members come from the cards of docs/graph: a type card (02) has the type itself, its state, relations, operations and events, and a
// subtype's additions; a presentation card (03) has the type itself, its slots and its operations. A `?` makes a member optional.
// Each member counts by state:
//   declared     in the native library (sdk/graph/native) or the framework's (sdk/graph/framework.mjs, for the cards of 07); a presentation
//                card's members in the presentation types (sdk/graph/presentations.mjs), its type also when the page has a binding or rule
//                for it, and its slots where a binding of it has one of that name (a slot's name is the card's in camelCase without
//                "the": `trailing actions` is `trailingActions`; docs/design/systems.md "E7 in detail");
//   implemented  realized by the native provider (providers/codex/realizes.mjs) or the framework's (providers/framework: its `realizes`): the
//                types it puts, with their core members, the optional
//                members it supports, the operations it handles, the relations it links and their inverses, the events it emits), or, for a presentation type,
//                by a binding or rule (framework/renderer/present/addresses.json; the Window and the framework's own presentation types
//                by the windows provider), with the operations and events the windows provider realizes (providers/windows: its
//                `realizes`), its core state and the bindings' slots. The Presentation concept counts once: its state, relations and
//                events as the windows provider realizes them, and 03's generic operations, which are the rule API's (`_read` and `_act`
//                are `ui._read` and `ui._act`, the others the rule kinds of host/ui-rules.mjs). A binding realizes its type only when what
//                it presents is among the card's `Presents` (or their subtypes); one that is not is listed as mismatched;
//   verified     shown natively: by a ledger entry with its proof (docs/coverage/verified.json), or by a census the ledger lists
//                (qa.graph-census in a QA copy: the members the native provider filled on that build);
//   excluded     by a ledger entry, with its reason.
// Each member also has its investment tier (docs/design/graph-layers.md §4, docs/coverage/tiers.json): supported (verified natively
// and kept working), asBuilt (realized where it works) or mechanism (the `_` layer: listed, not counted). A data card's members take its
// tier, a member named `_...` or listed is mechanism; a presentation card's type and slots take its tier and its state, relations,
// operations and events are its instances' (mechanism), except the Window's and the Presentation concept's generic operations (the
// declaration grammar).
// A feature (a row of 01) is realized when every core member of every card it names is, by its tier, verified (supported) or implemented
// (asBuilt), or excluded; mechanism members are not asked. It reads files only.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cards, withoutExamples, GRAPH_DIR } from './graph-check.mjs';
import { NATIVE_TYPES } from '../sdk/graph/native/index.mjs';
import { toDescriptor } from '../sdk/graph/define.mjs';
import { REALIZES as NATIVE_REALIZES } from '../framework/host/graph/providers/codex/realizes.mjs';
import { FRAMEWORK_TYPES } from '../sdk/graph/framework.mjs';
import { realizes as FRAMEWORK_REALIZES } from '../framework/host/graph/providers/framework/index.mjs';
import { PRESENTATION_TYPES } from '../sdk/graph/presentations.mjs';
import { realizes as WINDOWS_REALIZES, FRAMEWORK_TYPES as FRAMEWORK_PRESENTATIONS } from '../framework/host/graph/providers/windows/index.mjs';
import { KINDS as RULE_KINDS } from '../framework/host/ui-rules.mjs';
import { BINDINGS } from '../framework/renderer/present/bindings/index.mjs';

/** What the providers of this repository realize: the native provider's and the framework's (docs/graph/07, systems.md S3), merged. */
const REALIZES = (() => {
  const merge = (key) => {
    const out = {};
    for (const r of [NATIVE_REALIZES, FRAMEWORK_REALIZES]) for (const [t, list] of Object.entries(r[key] ?? {})) out[t] = [...(out[t] ?? []), ...list];
    return out;
  };
  return { types: [...NATIVE_REALIZES.types, ...FRAMEWORK_REALIZES.types], operations: merge('operations'), supports: merge('supports'), events: merge('events'), links: merge('links') };
})();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LEDGER = join(ROOT, 'docs', 'coverage', 'verified.json');
export const TIERS = join(ROOT, 'docs', 'coverage', 'tiers.json');
const ADDRESSES = join(ROOT, 'framework', 'renderer', 'present', 'addresses.json');
const SECTIONS = { State: 'state', Relations: 'relations', Operations: 'operations', Events: 'events', Adds: 'adds', Slots: 'slots' };
const TYPE = '';   // the member that stands for the type itself

/** A slot's identifier from its name on a card: its words in camelCase, without "the" (`after the answer` -> `afterAnswer`). */
export const slotId = (name) => String(name).trim().split(/\s+/).filter((w) => w.toLowerCase() !== 'the')
  .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join('');
/** 03's generic operations of every presentation: `_read` and `_act` through the graph (ui._read, ui._act), the rest the rule kinds. */
const GENERIC_BY_GRAPH = ['_read', '_act'];

/** Split on `·` outside brackets. */
function splitTop(text) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of text) {
    if ('({['.includes(ch)) depth++;
    else if (')}]'.includes(ch)) depth = Math.max(0, depth - 1);
    if (ch === '·' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** The members a card lists: {name, section, tier}. */
function membersOf(fields) {
  const out = [{ name: TYPE, section: 'type', tier: 'core' }];
  for (const [field, section] of Object.entries(SECTIONS)) {
    const text = fields[field];
    if (!text || text.trim() === '—') continue;
    const items = section === 'adds' ? splitTop(text.replace(/(^|;)\s*-\s+/g, ' · ')) : splitTop(text);
    for (const item of items) {
      let m;
      if (section === 'events') m = item.match(/^(_?[a-z]\w*)()/);
      else if (section === 'slots') m = [null, slotId(item.replace(/\(.*$/, '')), ''];
      else if (section === 'operations') m = item.match(/^(_?[a-z]\w*)(\?)?\s*\(/);
      else m = item.match(/^(_?[a-z]\w*)(\?)?\s*[:(]/);
      if (!m || !m[1]) continue;
      const name = m[1];
      if (out.some((x) => x.name === name && x.section === section)) continue;
      out.push({ name, section, tier: m[2] === '?' ? 'optional' : 'core' });
    }
  }
  return out;
}

/** 01: the feature areas, each with its rows ({feature, cards}). */
function areasOf(text) {
  const areas = [];
  for (const block of text.split(/^(?=## F\d+ )/m)) {
    const h = block.match(/^## (F\d+) (.+)$/m);
    if (!h) continue;
    const rows = [];
    for (const [, feature, ts, ps] of block.matchAll(/^\|(?!---)(.+)\|(.+)\|(.+)\|$/gm)) {
      if (feature.trim() === 'Feature') continue;
      rows.push({ feature: feature.trim(), cards: [...new Set([...(ts.match(/\b[A-Z]\w+/g) ?? []), ...(ps.match(/\b[A-Z]\w+/g) ?? [])])] });
    }
    areas.push({ id: h[1], title: h[2].trim(), rows });
  }
  return areas;
}

/**
 * @param {{ graphDir?: string, ledger?: string, addresses?: string }} [o]
 * @returns {{ areas: object[], total: object, problems: string[], members: object[] }}
 */
export function coverage(o = {}) {
  const graphDir = o.graphDir ?? GRAPH_DIR;
  const read = (f) => readFileSync(join(graphDir, f), 'utf8');
  // The framework's own cards (07) count like 02's, and its feature table like 01's areas.
  const f07 = existsSync(join(graphDir, '07-framework.md')) ? withoutExamples(read('07-framework.md')) : '';
  const f02 = `${withoutExamples(read('02-types.md'))}\n${f07}`;
  const typeCards = cards(f02, /^## (\w+) {2,}(concept|subtype|value)/);
  const f03 = withoutExamples(read('03-presentations.md'));
  const presCards = cards(f03, /^## (\w+) {2,}(presentation|concept)/);
  const generic = [...(f03.split(/^(?=## )/m).find((b) => /^## Presentation {2,}concept/.test(b)) ?? '').matchAll(/^\| \*\*(\w+)\*\* \|/gm)].map((x) => x[1]);
  const problems = [];

  // The hierarchy, from the cards ("subtype of"), so non-native types have subtrees too.
  const parentOf = new Map();
  for (const [, st, parent] of f02.matchAll(/^## (\w+) {2,}subtype of (\w+)/gm)) parentOf.set(st, parent);
  const subtree = (t) => { const out = new Set([t]); let grew = true; while (grew) { grew = false; for (const [c, p] of parentOf) if (out.has(p) && !out.has(c)) { out.add(c); grew = true; } } return out; };

  const native = new Map([...NATIVE_TYPES, ...FRAMEWORK_TYPES].map((d) => [d.id, toDescriptor(d)]));
  const addresses = JSON.parse(readFileSync(o.addresses ?? ADDRESSES, 'utf8'));
  // A binding counts for its type only when what it presents is among the card's `Presents` (or a subtype of one; "any" takes any).
  const presentsOf = new Map(BINDINGS.map((b) => [b.id, Array.isArray(b.presents) ? b.presents : []]));
  const cardPresents = (p) => {
    const text = presCards.get(p)?.fields.Presents ?? '';
    return { any: /\bany\b/.test(text), names: new Set(text.match(/\b[A-Z]\w+/g) ?? []) };
  };
  const presentable = (p, t) => {
    const { any, names } = cardPresents(p);
    for (let x = t; x; x = parentOf.get(x)) if (any || names.has(x)) return true;
    return false;
  };
  const mismatched = [];
  const placed = [...(addresses.bindings ?? []), ...(addresses.rules ?? [])].filter((b) => {
    if (typeof b.presentation !== 'string' || b.target === false) return false;
    const off = (presentsOf.get(b.id) ?? []).filter((t) => !presentable(b.presentation, t));
    if (off.length) mismatched.push(`${b.id}: ${b.presentation} presents ${off.join(', ')}, not on its card`);
    return !off.length;
  });
  // presented by a binding, the Window, the framework's own (E6.5), or put by the windows provider itself (outside a window: the Dock's
  // badge); a type with a binding is counted by its bindings alone (one that presents what its card does not counts for nothing)
  const bound = new Set((addresses.bindings ?? []).map((b) => b.presentation).filter((x) => typeof x === 'string'));
  const realizedPres = new Set([...placed.map((b) => b.presentation), 'Window', ...FRAMEWORK_PRESENTATIONS, ...WINDOWS_REALIZES.types.filter((t) => !bound.has(t))]);
  const slotsOf = new Map();
  const addSlots = (p, slots) => { const set = slotsOf.get(p) ?? new Set(); for (const x of slots ?? []) set.add(x); slotsOf.set(p, set); };
  // the bindings that present nothing themselves and only realize others' slots (twins, E7)
  const twinOnly = (addresses.bindings ?? []).filter((b) => typeof b.presentation !== 'string' && b.target !== false && Array.isArray(b.twins));
  for (const b of [...placed, ...twinOnly]) {
    addSlots(b.presentation, b.slots);
    for (const t of b.twins ?? []) if (t && typeof t.presentation === 'string') addSlots(t.presentation, t.slots);   // a twin's slots (E7)
  }
  /** What realizes a presentation member, as the report lists it. */
  const bindingsOf = (p, slot) => [...placed, ...twinOnly].filter((b) => (b.presentation === p && (!slot || (b.slots ?? []).includes(slot)))
    || (slot && (b.twins ?? []).some((t) => t.presentation === p && (t.slots ?? []).includes(slot)))).map((b) => b.id);
  const realizerOf = (p, m) => {
    if (m.generic) return GENERIC_BY_GRAPH.includes(m.name) ? `ui.${m.name} (the graph)` : `the rule API (${m.name})`;
    if (m.section === 'type') return p === 'Presentation' || p === 'Window' || !bindingsOf(p).length && WINDOWS_REALIZES.types.includes(p) ? 'the windows provider' : FRAMEWORK_PRESENTATIONS.includes(p) ? 'the framework\'s own (E6.5)' : bindingsOf(p).join(', ');
    if (m.section === 'slots') return bindingsOf(p, m.name).join(', ');
    if (m.section === 'operations') return (WINDOWS_REALIZES.operations[p] ?? []).includes(m.name) ? 'the windows provider' : '';
    return 'the windows provider';
  };
  const presSpecs = new Map(PRESENTATION_TYPES.map((d) => [d.id, toDescriptor(d)]));
  const winOps = (p, name, key) => (WINDOWS_REALIZES[key][p] ?? []).includes(name) || (WINDOWS_REALIZES[key].Presentation ?? []).includes(name);
  const realized = new Set(REALIZES.types);
  const ledgerFile = o.ledger ?? LEDGER;
  const ledger = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, 'utf8')) : { censuses: [], verified: [], excluded: [] };

  // ---------------------------------------------------------------- the members, with declared and implemented
  const members = [];
  const specMember = (t, m) => { const s = native.get(t)?.spec; return s && (s.state?.[m.name] ?? s.relations?.[m.name] ?? s.operations?.[m.name] ?? s.events?.[m.name]); };
  const linked = (types, name) => [...types].some((r) => realized.has(r) && (REALIZES.links[r] ?? []).includes(name));
  for (const [t, card] of typeCards) {
    if (card.kind === 'value') continue;
    const tree = subtree(t);
    const isImpl = [...tree].some((x) => realized.has(x));
    for (const m of membersOf(card.fields)) {
      const decl = m.section === 'type' ? native.has(t) : !!specMember(t, m);
      let impl;
      if (!decl || !isImpl) impl = false;
      else if (m.section === 'type') impl = true;
      else if (m.section === 'events') impl = [...tree].some((x) => (REALIZES.events?.[x] ?? []).includes(m.name));
      else if (m.section === 'operations') impl = [...tree].some((x) => (REALIZES.operations[x] ?? []).includes(m.name));
      else {
        const spec = native.get(t).spec;
        const rel = spec.relations?.[m.name];
        if (rel) impl = linked(tree, m.name) || (rel.inverseOf ? linked(subtree(rel.target), rel.inverseOf) : false);
        else impl = (spec.state?.[m.name]?.tier ?? 'core') !== 'optional' || [...tree].some((x) => (REALIZES.supports[x] ?? []).includes(m.name));
      }
      members.push({ card: t, kind: 'type', ...m, declared: decl, implemented: impl, verified: null, excluded: null });
    }
  }
  const winLinked = (name) => (WINDOWS_REALIZES.links?.Presentation ?? []).includes(name);
  for (const [p, card] of presCards) {
    if (card.kind !== 'presentation' && p !== 'Presentation') continue;
    const concept = p === 'Presentation';
    const spec = presSpecs.get(p)?.spec;
    const real = concept ? realizedPres.size > 0 : realizedPres.has(p);
    const list = membersOf(card.fields);
    if (concept) for (const name of generic) list.push({ name, section: 'operations', tier: 'core', generic: true });
    for (const m of list) {
      let decl, impl;
      if (m.section === 'type') { decl = presSpecs.has(p) || real; impl = real; }
      else if (m.section === 'slots') { decl = impl = real && !!slotsOf.get(p)?.has(m.name); }
      else if (m.generic) { decl = impl = GENERIC_BY_GRAPH.includes(m.name) || RULE_KINDS.includes(m.name); }
      else {
        const member = spec && (spec.state?.[m.name] ?? spec.operations?.[m.name] ?? spec.events?.[m.name] ?? spec.relations?.[m.name]);
        const rel = m.section === 'relations' ? spec?.relations?.[m.name] : null;
        decl = !!member;
        if (!decl || !real) impl = false;
        else if (m.section === 'operations') impl = winOps(p, m.name, 'operations');
        else if (m.section === 'events') impl = winOps(p, m.name, 'events');
        else if (rel) impl = winLinked(m.name) || (!!rel.inverseOf && winLinked(rel.inverseOf));
        else impl = (member.tier ?? 'core') !== 'optional' || winOps(p, m.name, 'supports');
      }
      const { generic: _g, ...rest } = m;
      members.push({ card: p, kind: 'presentation', ...rest, declared: decl, implemented: impl, verified: null, excluded: null, ...(impl ? { by: realizerOf(p, m) } : {}) });
    }
  }
  // ---------------------------------------------------------------- investment tiers (graph-layers.md §4)
  const tiers = JSON.parse(readFileSync(o.tiers ?? TIERS, 'utf8'));
  const tierOf = new Map([...(tiers.supported ?? []).map((t) => [t, 'supported']), ...(tiers.asBuilt ?? []).map((t) => [t, 'asBuilt']), ...(tiers.mechanism ?? []).map((t) => [t, 'mechanism'])]);
  const mechanismMembers = new Set(tiers.mechanismMembers ?? []);
  for (const c of new Set(members.map((m) => m.card))) if (!tierOf.has(c)) problems.push(`no investment tier for ${c} (docs/coverage/tiers.json)`);
  for (const m of members) {
    const t = tierOf.get(m.card) ?? 'asBuilt';
    const own = m.section === 'type' || m.section === 'slots';
    m.invest = (m.name && (m.name.startsWith('_') || mechanismMembers.has(`${m.card}.${m.name}`))) ? 'mechanism'
      : m.kind !== 'presentation' || m.card === 'Window' || t === 'mechanism' || own ? t
        : m.card === 'Presentation' && m.section === 'operations' ? t
          : 'mechanism';
  }
  const byCard = new Map();
  for (const m of members) { let l = byCard.get(m.card); if (!l) byCard.set(m.card, (l = [])); l.push(m); }

  // ---------------------------------------------------------------- the ledger
  /** "Type", "Type.member", "Type.state" (its core state), "Type.core" or "Type.*" -> the members it names (empty when unknown). */
  const resolve = (ref) => {
    const [card, name] = String(ref).split('.');
    const list = byCard.get(card) ?? [];
    if (name === undefined) return list.filter((m) => m.section === 'type');
    if (name === 'state') return list.filter((m) => (m.section === 'state' || m.section === 'adds') && m.tier === 'core');
    if (name === 'core') return list.filter((m) => m.tier === 'core');
    if (name === '*') return list;
    return list.filter((m) => m.name === name);
  };
  const dateOk = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d ?? ''));
  for (const c of ledger.censuses ?? []) {
    const file = join(ROOT, String(c.file ?? ''));
    if (!c.file || !existsSync(file)) { problems.push(`census missing: ${c.file}`); continue; }
    if (!c.build || !dateOk(c.date)) problems.push(`census ${c.file}: needs build and date`);
    const types = JSON.parse(readFileSync(file, 'utf8')).types ?? {};
    const shows = (tree, key, name) => [...tree].some((x) => (types[x]?.[key]?.[name] ?? 0) > 0);
    const proof = { by: 'census', build: c.build, date: c.date, proof: c.file };
    for (const m of members) {
      if (m.kind !== 'type' || m.verified) continue;
      const tree = subtree(m.card);
      let ok = false;
      if (m.section === 'type') ok = [...tree].some((x) => (types[x]?.count ?? 0) > 0);
      else if (m.section === 'state' || m.section === 'adds' || m.section === 'relations') {
        const rel = native.get(m.card)?.spec.relations?.[m.name];
        // An inverse shows through its other side's links, once its own instances are put (a link to a type not realized yet proves nothing).
        ok = shows(tree, 'state', m.name) || shows(tree, 'links', m.name) || (rel?.inverseOf && m.implemented ? shows(subtree(rel.target), 'links', rel.inverseOf) : false);
      }
      if (ok) m.verified = proof;
    }
  }
  for (const v of ledger.verified ?? []) {
    const found = resolve(v.member);
    if (!found.length) { problems.push(`verified names an unknown member: ${v.member}`); continue; }
    if (!v.build || !dateOk(v.date) || !v.proof) problems.push(`verified ${v.member}: needs build, date and proof`);
    // a proof is a file of this checkout, or (`history:<path>`) one of the project's design history that a published tree leaves out
    else if (!String(v.proof).startsWith('history:') && !existsSync(join(ROOT, String(v.proof).split('#')[0]))) problems.push(`verified ${v.member}: proof not found: ${v.proof}`);
    for (const m of found) m.verified ??= { by: 'ledger', build: v.build, date: v.date, proof: v.proof };
  }
  for (const x of ledger.excluded ?? []) {
    const found = resolve(x.member);
    if (!found.length) { problems.push(`excluded names an unknown member: ${x.member}`); continue; }
    if (!x.reason) problems.push(`excluded ${x.member}: needs a reason`);
    for (const m of found) m.excluded ??= x.reason;
  }
  for (const m of members) if (m.verified && !m.implemented) problems.push(`verified but not implemented: ${m.card}${m.name ? `.${m.name}` : ''} (${m.verified.proof})`);

  // ---------------------------------------------------------------- per feature area and in total
  const tally = (list) => {
    const sup = list.filter((m) => m.invest === 'supported'), built = list.filter((m) => m.invest === 'asBuilt');
    return {
      members: list.length, core: list.filter((m) => m.tier === 'core').length,
      declared: list.filter((m) => m.declared).length, implemented: list.filter((m) => m.implemented).length,
      verified: list.filter((m) => m.verified).length, excluded: list.filter((m) => m.excluded).length,
      supported: { members: sup.length, verified: sup.filter((m) => m.verified).length, excluded: sup.filter((m) => m.excluded).length },
      asBuilt: { members: built.length, implemented: built.filter((m) => m.implemented).length, excluded: built.filter((m) => m.excluded).length },
      mechanism: list.filter((m) => m.invest === 'mechanism').length,
    };
  };
  const met = (m) => m.excluded || m.invest === 'mechanism' || (m.invest === 'asBuilt' ? m.implemented : m.verified);
  const done = (card) => (byCard.get(card) ?? []).filter((m) => m.tier === 'core').every(met);
  const areas = areasOf(`${read('01-features.md')}\n${f07}`).map((a) => {
    const names = new Set(a.rows.flatMap((r) => r.cards).filter((c) => byCard.has(c)));
    return {
      id: a.id, title: a.title, rows: a.rows.length,
      realized: a.rows.filter((r) => r.cards.filter((c) => byCard.has(c)).every(done)).length,
      cards: names.size, ...tally(members.filter((m) => names.has(m.card))),
    };
  });
  const typeCount = [...typeCards.values()].filter((c) => c.kind !== 'value').length;
  const presCount = [...presCards.values()].filter((c) => c.kind === 'presentation').length;
  // The presentations' own totals (03, the Presentation concept with them): E7's measure (systems.md "E7 in detail").
  const presentations = tally(members.filter((m) => m.kind === 'presentation'));
  return { areas, total: { types: typeCount, presentations: presCount, ...tally(members) }, presentations, mismatched, problems, members };
}

/**
 * What the native provider realizes that no census or ledger entry has shown natively (graph-integrity G9.3, support follows capture): by
 * type, its operations, optional members, events and linked relations neither verified nor excluded. The provider declares them
 * `unverified` (providers/codex/unverified.mjs, kept equal to this by tests/coverage.test.mjs), so the framework's own surfaces do not
 * offer them until a native check verifies them. Sorted, for a stable file.
 */
export function unverifiedNative(r = coverage()) {
  const lists = [NATIVE_REALIZES.operations, NATIVE_REALIZES.supports, NATIVE_REALIZES.events, NATIVE_REALIZES.links];
  const realized = (type, name) => lists.some((l) => (l[type] ?? []).includes(name));
  const out = {};
  for (const m of r.members) {
    if (m.kind !== 'type' || !m.name || m.verified || m.excluded || !realized(m.card, m.name)) continue;
    (out[m.card] ??= []).push(m.name);
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, [...new Set(v)].sort()]));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = coverage();
  if (process.argv.includes('--unverified')) {
    process.stdout.write(`${JSON.stringify(unverifiedNative(r), null, 2)}\n`);
    process.exit(0);
  }
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ areas: r.areas, total: r.total, presentations: r.presentations, problems: r.problems }, null, 2)}\n`);
  else {
    const frac = (a, b) => `${a}/${b}`;
    const row = (label, x, rows) => `${label.padEnd(40)}${String(rows).padStart(7)}${String(x.members).padStart(9)}${frac(x.supported.verified + x.supported.excluded, x.supported.members).padStart(14)}${frac(x.asBuilt.implemented + x.asBuilt.excluded, x.asBuilt.members).padStart(14)}${String(x.mechanism).padStart(11)}${String(x.verified).padStart(10)}${String(x.excluded).padStart(10)}\n`;
    process.stdout.write(`${'Area'.padEnd(40)}${'rows'.padStart(7)}${'members'.padStart(9)}${'supported ok'.padStart(14)}${'as built ok'.padStart(14)}${'mechanism'.padStart(11)}${'verified'.padStart(10)}${'excluded'.padStart(10)}\n`);
    for (const a of r.areas) process.stdout.write(row(`${a.id} ${a.title}`, a, `${a.realized}/${a.rows}`));
    process.stdout.write(row(`All (${r.total.types} types, ${r.total.presentations} presentation types)`, r.total, ''));
    process.stdout.write(row('Presentations (03, with the concept)', r.presentations, ''));
    if (r.mismatched.length) process.stdout.write(`not counted (presents what its card does not): ${r.mismatched.length}\n${r.mismatched.map((x) => `  ${x}\n`).join('')}`);
    // --presentations: every presentation member with what realizes it and its proof (E7's matrix)
    if (process.argv.includes('--presentations')) {
      for (const m of r.members.filter((x) => x.kind === 'presentation')) {
        const name = `${m.card}${m.name ? `.${m.name}` : ''}${m.section === 'type' ? '' : ` (${m.section})`}`;
        const state = m.excluded ? `excluded: ${m.excluded}` : m.verified ? `verified ${m.verified.date}: ${m.verified.proof}` : m.implemented ? 'implemented' : m.declared ? 'declared' : 'open';
        process.stdout.write(`  ${name.padEnd(44)}${(m.by ?? '').padEnd(34)}${state}\n`);
      }
    }
    process.stdout.write(`problems: ${r.problems.length}\n${r.problems.map((p) => `  ${p}\n`).join('')}`);
  }
  process.exitCode = r.problems.length ? 1 : 0;
}
