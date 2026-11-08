#!/usr/bin/env node
// The feature log (docs/design/systems.md S16, "E4 in detail"): generated from the code's own declarations and a scan of what each unit
// reaches in the app, into framework/host/features/log.json. Usage: node scripts/features.mjs [--check] [--units]
//   --check  exit 1 when the committed log differs from what the code gives (tests/features-log.test.mjs runs it)
//   --units  print what the scan found per unit (for writing the declarations)
// Repository tooling: it reads the type library, the providers' `realizes`, the bindings' addresses, the units' declarations
// (framework/host/features/units.mjs), the SDK's entries (framework/host/features/sdk.mjs) and the reference builds' evidence
// (adapters/<build>/). The Host reads only the JSON it writes.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { NATIVE_TYPES } from '../sdk/graph/native/index.mjs';
import { FRAMEWORK_TYPES } from '../sdk/graph/framework.mjs';
import { PRESENTATION_TYPES } from '../sdk/graph/presentations.mjs';
import { toDescriptor } from '../sdk/graph/define.mjs';
import { CORE } from '../framework/host/graph/providers/codex/realizes.mjs';
import { AREAS } from '../framework/host/graph/providers/codex/areas.mjs';
import { realizes as FRAMEWORK_REALIZES } from '../framework/host/graph/providers/framework/index.mjs';
import { realizes as WINDOWS_REALIZES } from '../framework/host/graph/providers/windows/index.mjs';
import { UNITS as BASE_UNITS, NOT_MECHANICS } from '../framework/host/features/units.mjs';
import { DECLS } from '../framework/host/features/declarations.mjs';
import { SDK_FEATURES } from '../framework/host/features/sdk.mjs';
import { titleOf } from '../framework/host/features/status.mjs';
import { EXPOSURES } from '../adapters/tools/seams.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** The units with their declarations (declarations.mjs, by unit id). */
const UNITS = BASE_UNITS.map((u) => (DECLS[u.id] ? { ...u, ...DECLS[u.id], notMechanics: [...(u.notMechanics ?? []), ...(DECLS[u.id].notMechanics ?? [])],
  unchecked: [...(u.unchecked ?? []), ...(DECLS[u.id].unchecked ?? [])] } : u));
export const LOG = join(ROOT, 'framework', 'host', 'features', 'log.json');
/** The builds whose evidence the log takes as its reference: their packs ship with this framework, and their census and tests ran. A
 *  build becomes a reference only by being added here. */
export const REFERENCE_BUILDS = Object.freeze(['26.1103.41825-25679', '26.1027.30824-22943', '26.1016.62342-21477', '26.1013.40934-20770']);

const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const uniq = (a) => [...new Set(a)];
const sorted = (a) => uniq(a).sort();

/** Code without its comments (strings kept), so a method named in a comment is not a call. */
function code(text) {
  let out = '', i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) { if (text[j] === '\\') j++; j++; }
      out += text.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); const end = e < 0 ? text.length : e + 2; out += text.slice(i, end).replace(/[^\n]/g, ''); i = end; continue; }
    out += c; i++;
  }
  return out;
}

/** What a unit's files reach, by scan: method literals; framework-main's area-kit calls; dynamic sites. */
export function scanUnit(texts) {
  const found = { methods: new Set(), services: new Set(), messages: new Set(), commands: new Set(), routes: new Set(), state: new Set(), unchecked: new Set(), dynamic: [] };
  for (const [file, raw] of texts) {
    const t = code(raw);
    const line = (i) => `${file.replace(/^.*\//, '')}:${t.slice(0, i).split('\n').length}`;
    for (const m of t.matchAll(/(['"`])([a-z][A-Za-z0-9]*(?:\/[A-Za-z][A-Za-z0-9]*){1,3})\1/g)) found.methods.add(m[2]);
    // a request whose method is not a literal (a pass-through of `method` is its caller's literal)
    for (const m of t.matchAll(/\b(?:request|rpc)\(\s*(?![\s'"`]|method\b)([A-Za-z_$][\w$.[\]]*)\s*[,)]/g)) found.dynamic.push({ site: line(m.index), what: `request(${m[1]})` });
    // framework-main: AppHost services
    for (const m of t.matchAll(/\bservice\(\s*hooks\s*,\s*(['"`])([A-Za-z]\w*)\1/g)) found.services.add(m[2]);
    for (const m of t.matchAll(/\bservice\(\s*hooks\s*,\s*(?![\s'"`])([^,)]+)/g)) found.dynamic.push({ site: line(m.index), what: `service(${m[1].trim()})` });
    for (const m of t.matchAll(/\bservices\??\.([A-Za-z]\w*)\b(?!\s*\()/g)) found.services.add(m[1]);   // `services.x.method(`, not a Set's `services.add(`
    if (/\bkit\.invalidate\(/.test(t)) found.services.add('queryCache');
    if (/\bkit\.appAction\(/.test(t)) found.services.add('appActions');
    if (/\bkit\.globalState\(/.test(t)) found.services.add('projects');
    // host messages, commands, pages
    for (const m of t.matchAll(/\bpostToView\([^,]+,[^,]+,\s*\{\s*type:\s*(?:(['"`])([a-z][\w-]*)\1|([^,}]+))/g)) {
      if (m[2]) found.messages.add(m[2]); else found.dynamic.push({ site: line(m.index), what: `postToView(type: ${m[3].trim()})` });
    }
    for (const m of t.matchAll(/\brunCommand\([^,]+,[^,]+,\s*(?:(['"`])([\w.-]+)\1|([^,)]+))/g)) {
      found.messages.add('run-command');
      if (m[2]) found.commands.add(m[2]); else found.dynamic.push({ site: line(m.index), what: `runCommand(${m[3].trim()})` });
    }
    for (const m of t.matchAll(/\bnavigate\(\s*hooks\s*,[^,]+,\s*(?:(['"])(\/[^'"]*)\1|`(\/[^`$]*)|([^,)]+))/g)) {
      found.messages.add('navigate-to-route');
      if (m[2]) found.routes.add(m[2]); else if (m[3] !== undefined) found.routes.add(m[3]); else found.dynamic.push({ site: line(m.index), what: `navigate(${m[4].trim()})` });
    }
    for (const m of t.matchAll(/type:\s*'(navigate-to-route|run-command)'/g)) found.messages.add(m[1]);
    // the app's stored state (its global state store's keys)
    for (const m of t.matchAll(/\.(?:get|onDidChange)\(\s*'([a-z][a-z0-9]*(?:-[a-z0-9]+)+)'/g)) found.state.add(m[1]);
    // what no build evidence checks
    for (const m of t.matchAll(/\bappAction\(\s*hooks\s*,\s*\{\s*type:\s*'([\w.]+)'/g)) found.unchecked.add(`action ${m[1]}`);
    for (const m of t.matchAll(/\bfollowerRequest\([^,]+,[^,]+,\s*'([\w-]+)'/g)) found.unchecked.add(`follower request ${m[1]}`);
    for (const m of t.matchAll(/\bhooks\.electron\.([A-Za-z]\w*)/g)) found.unchecked.add(`electron ${m[1]}`);
  }
  return found;
}

/** The reference builds' evidence: their catalogs (with fingerprints), state keys and bindings' evidence. */
function references() {
  const protocol = {}, bindings = {}, kinds = { services: new Set(), messages: new Set(), commands: new Set(), routes: new Set(), state: new Set() };
  for (const b of REFERENCE_BUILDS) {
    const facts = readJson(`adapters/${b}/build-facts.json`).families;
    const fps = facts['protocol.schema'].fingerprints ?? {};
    for (const v of facts['protocol.schema'].values) {
      const m = v.slice(v.indexOf(':') + 1);
      const e = protocol[m] ??= { in: 'schema', fp: [] };
      e.in = 'schema';
      if (fps[v] && !e.fp.includes(fps[v])) e.fp.push(fps[v]);
    }
    for (const m of facts['protocol.wireOnly'].values) protocol[m] ??= { in: 'wireOnly', fp: [] };
    for (const v of facts['apphost.services'].values) kinds.services.add(v);
    for (const v of facts['bus.toView'].values) kinds.messages.add(v);
    for (const v of facts['commands.ids'].values) kinds.commands.add(v);
    for (const v of facts['routes.paths'].values) kinds.routes.add(v);
    for (const v of [...facts['state.globalKeys'].values, ...facts['state.persistedAtoms'].values]) kinds.state.add(v);
    const sites = facts['bindings.sites']?.sites ?? {};
    for (const [id, s] of Object.entries(sites)) {
      const strength = s.jsx ? 'jsx' : s.objects ? 'objects' : null;
      if (!strength) continue;
      if (!bindings[id] || (bindings[id] === 'jsx' && strength === 'objects')) bindings[id] = strength;   // the weakest a reference accepted
    }
  }
  for (const e of Object.values(protocol)) e.fp.sort();
  return { protocol, bindings, kinds };
}

/** The type tree: each type's parent, from the library. */
function typeTree() {
  const parent = new Map(), kind = new Map(), ops = new Map();
  for (const d of [...NATIVE_TYPES, ...FRAMEWORK_TYPES, ...PRESENTATION_TYPES].map(toDescriptor)) {
    parent.set(d.id, d.parent ?? null); kind.set(d.id, d.kind);
    ops.set(d.id, Object.keys(d.spec?.operations ?? {}));
  }
  return { parent, kind, ops };
}

/** The log, from the code. */
export function generate() {
  const ref = references();
  const tree = typeTree();
  const features = {}, mechanics = {}, units = {};
  const feature = (id, data) => (features[id] ??= { title: data.title, version: 1, needs: [], prefers: [], ...data });
  const mechanic = (id, unit) => { const m = mechanics[id] ??= { title: titleOf(id), units: [] }; if (unit && !m.units.includes(unit)) m.units.push(unit); return id; };
  const problems = [];

  // ---- the graph's features: every type a framework provider puts, its concepts, and each operation it realizes
  const realized = { types: new Set(), ops: new Map() };
  const addRealizes = (r) => {
    for (const t of r.types ?? []) realized.types.add(t);
    for (const [t, list] of Object.entries(r.operations ?? {})) for (const op of list) { const k = `${t}.${op}`; realized.ops.set(k, t); }
  };
  addRealizes(CORE);
  for (const a of Object.values(AREAS)) addRealizes(a.realizes ?? {});
  const frameworkTypes = new Set([...(FRAMEWORK_REALIZES.types ?? [])]);
  addRealizes(FRAMEWORK_REALIZES);
  for (const t of [...realized.types].sort()) {
    feature(`graph:${t}`, { title: `the ${t} type`, ...(frameworkTypes.has(t) ? { framework: true } : {}) });
    for (let p = tree.parent.get(t); p; p = tree.parent.get(p)) {
      const f = feature(`graph:${p}`, { title: `the ${p} type`, realizedBy: [] });
      if (f.realizedBy && !f.realizedBy.includes(`graph:${t}`)) f.realizedBy.push(`graph:${t}`);
    }
  }
  for (const [k, t] of [...realized.ops].sort()) {
    const f = feature(`graph:${k}`, { title: `the ${k} operation` });
    if (!f.needs.includes(`graph:${t}`)) f.needs.push(`graph:${t}`);
  }

  // ---- the units: scan, classify, join with the declarations
  const servesOf = (u) => {
    if (u.serves) return u.serves;
    const r = AREAS[u.area]?.realizes ?? {};
    return [...(r.types ?? []).map((t) => `graph:${t}`), ...Object.entries(r.operations ?? {}).flatMap(([t, l]) => l.map((op) => `graph:${t}.${op}`))];
  };
  const scans = {};
  for (const u of UNITS) {
    const texts = u.files.filter((f) => existsSync(join(ROOT, f))).map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]);
    if (!texts.length) { if (!u.optional) problems.push(`${u.id}: none of its files exists`); continue; }
    const s = scanUnit(texts);
    scans[u.id] = s;
    const found = [];
    for (const m of s.methods) {
      if (NOT_MECHANICS.includes(m) || (u.notMechanics ?? []).includes(m)) continue;
      if (ref.protocol[m]) found.push(`protocol:${m}`);
      else problems.push(`${u.id}: "${m}" looks like a method but no reference build has it (declare it in notMechanics, or it is a typo)`);
    }
    for (const v of s.services) found.push(`service:${v}`);
    for (const v of s.messages) found.push(`message:${v}`);
    for (const v of s.commands) found.push(`command:${v}`);
    for (const v of s.routes) found.push(`route:${v}`);
    for (const v of s.state) {
      if (ref.kinds.state.has(v)) found.push(`state:${v}`);
      else if (!(u.notMechanics ?? []).includes(v)) problems.push(`${u.id}: "${v}" is read like a stored state key but no reference build has it (declare it)`);
    }
    for (const d of s.dynamic) if (!(u.dynamic ?? []).some((x) => x.site === d.site)) problems.push(`${u.id}: a dynamic call site is not declared: ${d.site} ${d.what}`);
    for (const x of u.dynamic ?? []) if (!s.dynamic.some((d) => d.site === x.site)) problems.push(`${u.id}: a declared dynamic site is not in the code: ${x.site}`);
    const declared = [...(u.needs ?? []), ...(u.dynamic ?? []).flatMap((x) => x.mechanics ?? [])];
    const all = sorted([...found, ...declared, ...(u.anyOf ?? []).flat()]);
    const serves = servesOf(u);
    for (const f of serves) if (!features[f]) problems.push(`${u.id}: serves ${f}, which no provider realizes`);
    for (const [m, list] of Object.entries(u.assign ?? {})) {
      if (!all.includes(m)) problems.push(`${u.id}: assigns ${m}, which it does not reach`);
      for (const f of list) if (!features[f]) problems.push(`${u.id}: assigns ${m} to ${f}, which no provider realizes`);
    }
    for (const m of u.prefers ?? []) if (!all.includes(m)) problems.push(`${u.id}: prefers ${m}, which it does not reach`);
    const grouped = new Set((u.anyOf ?? []).flat());
    for (const m of all) {
      mechanic(m, u.id);
      if (grouped.has(m)) continue;
      const targets = u.assign?.[m] ?? serves;
      const into = (u.prefers ?? []).includes(m) ? 'prefers' : 'needs';
      for (const f of targets) if (features[f] && !features[f][into].includes(m)) features[f][into].push(m);
    }
    for (const group of u.anyOf ?? []) for (const f of serves) if (features[f]) features[f].needs.push({ anyOf: [...group] });
    units[u.id] = { files: u.files, serves: sorted(serves), unchecked: sorted([...s.unchecked, ...(u.unchecked ?? [])]),
      ...(u.dynamic?.length ? { dynamic: u.dynamic.map((x) => ({ site: x.site, reason: x.reason, ...(x.mechanics ? { mechanics: x.mechanics } : {}) })) } : {}) };
  }

  // ---- presentations, from the bindings' addresses
  const addresses = readJson('framework/renderer/present/addresses.json');
  const placed = [...(addresses.bindings ?? []).map((b) => ({ ...b, kind: 'binding' })), ...(addresses.rules ?? []).map((r) => ({ ...r, kind: 'rule' }))];
  for (const b of placed) {
    const needs = sorted([...(b.needs?.seams ?? []).map((x) => `seam:${x}`), ...(b.needs?.exposures ?? []).map((x) => `exposure:${x}`),
      ...(b.exposure ? [`exposure:${b.exposure}`] : []), ...(b.scope ? ['exposure:useScope', `exposure:${b.scope}`] : [])]);
    if (b.kind === 'binding') { const id = mechanic(`binding:${b.id}`); mechanics[id].needs = needs; if (!b.keys?.length) mechanics[id].keyless = true; }
    // the app's own parts it draws (docs/design/public-hooks.md §3.10): a feature per slot of parts, needing what this entry needs
    const of = typeof b.partsOf === 'string' ? b.partsOf : b.presentation;
    for (const slot of Object.keys(b.parts ?? {})) {
      if (typeof of !== 'string') continue;
      const pf = feature(`parts:${of}.${slot}`, { title: `the app's own parts of the ${of} ${slot}` });
      for (const m of b.kind === 'binding' ? [`binding:${b.id}`, ...needs] : needs) { mechanic(m); if (!pf.needs.includes(m)) pf.needs.push(m); }
    }
    // an entry that only draws parts is not what its presentation needs
    if (typeof b.presentation !== 'string' || b.target === false || b.partsOnly === true) continue;
    const f = feature(`presentation:${b.presentation}`, { title: `the ${b.presentation} presentation` });
    for (const m of b.kind === 'binding' ? [`binding:${b.id}`, ...needs] : needs) { mechanic(m); if (!f.needs.includes(m)) f.needs.push(m); }
    // the page's own messages to the app's main that framework-main holds for its slots (a link route: open-in-browser)
    const held = (b.needs?.fromView ?? []).map((x) => `fromView:${x}`);
    for (const slot of b.slots ?? []) {
      const sf = feature(`slot:${b.presentation}.${slot}`, { title: `the ${b.presentation} ${slot} slot` });
      for (const m of [`presentation:${b.presentation}`, ...held]) { if (m.startsWith('fromView:')) mechanic(m); if (!sf.needs.includes(m)) sf.needs.push(m); }
      // what a slot does best effort (a redaction masks the app's copies through the copy seam; without it, only what is shown)
      for (const x of b.prefers?.slots?.[slot] ?? []) { const m = mechanic(`seam:${x}`); if (!sf.prefers.includes(m)) sf.prefers.push(m); }
    }
  }
  // the types the windows provider puts, and those it acts on (the framework's own types have operations too: a mod's Dialog, a desktop banner)
  for (const t of [...(WINDOWS_REALIZES.types ?? []), ...Object.keys(WINDOWS_REALIZES.operations ?? {})]) if (!features[`presentation:${t}`]) feature(`presentation:${t}`, { title: `the ${t} presentation` });
  // What is on screen can be read (a mod's `graph.read:Window`) and acted on (the windows provider's operations), when its presentation is
  // realized
  for (const t of [...(WINDOWS_REALIZES.types ?? []), ...Object.keys(WINDOWS_REALIZES.operations ?? {})]) if (!features[`graph:${t}`]) feature(`graph:${t}`, { title: `the ${t} type`, needs: [`presentation:${t}`] });
  for (const [t, ops] of Object.entries(WINDOWS_REALIZES.operations ?? {})) {
    for (const op of ops) feature(`graph:${t}.${op}`, { title: `the ${t}.${op} operation`, needs: [`presentation:${t}`] });
  }
  // Style rules set the app's own variables to theme tokens in the page (present/styles.mjs): nothing of the app's code beyond its CSS
  feature('presentation:Theme', { title: 'style rules on the app\'s theme' });
  for (const m of Object.keys(mechanics)) if (/^(seam|exposure):/.test(m)) mechanics[m].title = titleOf(m);
  // a member of an exposed namespace that the namespace's locator requires (seams.mjs `guarantees`) is there wherever it is located
  for (const m of Object.keys(mechanics)) {
    const [, ns, member] = /^exposure:([^.]+)\.(.+)$/.exec(m) ?? [];
    if (ns && EXPOSURES.find((e) => e.key === ns)?.guarantees?.includes(member)) { mechanics[m].via = `exposure:${ns}`; mechanic(`exposure:${ns}`); }
  }

  // ---- the SDK's entry points
  for (const s of SDK_FEATURES) {
    const f = feature(`sdk:${s.id}`, { title: s.title, ...(s.version ? { version: s.version } : {}), ...(s.accepts ? { accepts: s.accepts } : {}) });
    for (const m of s.needs ?? []) { mechanic(m); f.needs.push(m); }
    for (const m of s.prefers ?? []) { mechanic(m); f.prefers.push(m); }
  }

  // ---- order, and the reference evidence the evaluator compares with
  for (const f of Object.values(features)) {
    f.needs = [...f.needs.filter((x) => typeof x === 'string').sort(), ...f.needs.filter((x) => typeof x !== 'string')];
    f.prefers.sort();
    if (f.realizedBy) f.realizedBy.sort();
    if (!f.prefers.length) delete f.prefers;
  }
  for (const m of Object.values(mechanics)) { m.units.sort(); if (!m.units.length) delete m.units; }
  const sortObj = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  const log = {
    log: 1,
    reference: { builds: [...REFERENCE_BUILDS], protocol: sortObj(ref.protocol), bindings: sortObj(ref.bindings) },
    features: sortObj(features), mechanics: sortObj(mechanics), units: sortObj(units),
  };
  return { log, problems, scans };
}

export const hashOf = (log) => createHash('sha256').update(JSON.stringify(log)).digest('hex').slice(0, 16);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { log, problems, scans } = generate();
  if (process.argv.includes('--units')) {
    for (const [id, s] of Object.entries(scans)) {
      process.stdout.write(`${id}\n  methods ${[...s.methods].sort().join(' ')}\n  services ${[...s.services].sort().join(' ')}\n  messages ${[...s.messages].sort().join(' ')}`
        + `\n  commands ${[...s.commands].join(' ')}\n  routes ${[...s.routes].join(' ')}\n  state ${[...s.state].join(' ')}\n  unchecked ${[...s.unchecked].join(' ')}\n`
        + `  dynamic ${s.dynamic.map((d) => `${d.site} ${d.what}`).join('; ')}\n`);
    }
  }
  for (const p of problems) process.stderr.write(`problem: ${p}\n`);
  const text = `${JSON.stringify(log, null, 1)}\n`;
  if (process.argv.includes('--check')) {
    const now = existsSync(LOG) ? readFileSync(LOG, 'utf8') : '';
    if (now !== text || problems.length) { process.stderr.write(now !== text ? 'the feature log is not current: run node scripts/features.mjs\n' : ''); process.exitCode = 1; }
  } else if (!process.argv.includes('--units')) {
    if (problems.length) { process.exitCode = 1; process.stderr.write('not written\n'); } else { writeFileSync(LOG, text); process.stdout.write(`${LOG}: ${Object.keys(log.features).length} features, ${Object.keys(log.mechanics).length} mechanics\n`); }
  }
}
