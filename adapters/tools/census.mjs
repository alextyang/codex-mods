#!/usr/bin/env node
// The per-build census (docs/design/integration.md §9): the facts a build offers, for capabilities, the feature log and update risk.
// Node built-ins only, plain ESM (js-shape.mjs, hence acorn, is loaded lazily and only to settle which binding a call-site name means; see callSites). Its output is the adapter pack's build-facts.json.
//
// PROPOSAL (port A, the 22943 port): census.mjs with bus.fromView, bus.toView, bus.fetchHandlers and protocol.wireOnly ported (any quote spelling, any chunk); every other family as in census.mjs.
//
//   node adapters/tools/census.mjs <app.asar | extracted-asar-dir> <schemaDir> <schemaExperimentalDir> [--only=id,id] [--full-i18n] [--compact]
//   import { census } from './census.mjs'; census(input, schemaDir, schemaExperimentalDir, { only, fullI18n }) → the same object
//
// Input is the app.asar file or its extraction (main process in vite/build or .vite/build, renderer chunks in webview/assets).
// Output: one JSON object on stdout (the shape proposed for build-facts.json); exit code 0 = every family ok, 2 = at least one failed.
//
// Every family is located by strings and structure (template literals, message-id strings, enum arrays, call shapes), never by a
// minified identifier. Identifiers are only *captured* from structure and then followed (alias chasing through `export{a as b}` /
// `import{b as c}from"./chunk.js"`, const resolution, one-hop enum members). Each family verifies its anchor count (`anchorHits` is what it
// demanded and found) and FAILS LOUDLY ({status:"fail", error}) when an anchor matches 0 or more than the expected number of times.
// A failed family emits no values. Roles (main bundle, app-initial, app-shared) are themselves located by anchor, so one anchor drift
// cascades to every family that depends on that role: loud by design.
import { readFileSync, readdirSync, existsSync, statSync, openSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { addressesDigest } from '../../framework/host/features/evidence.mjs';
import { createRequire } from 'node:module';
import { JSX_RE, LAZY_RE, LAZY_GUARD, TAP_TABLE_RE, TAP_HANDLERS_RE, TAP_MESSAGES_RE, MENU_RE, MENU_NEEDLE, APP_HOST_RE, APP_HOST_INLINE_RE, corpusOf, deriveExposures, EXPOSURES } from './seams.mjs';

// =====================================================================================================================
// 1. Structural scanner (strings, templates, regex literals, comments, brackets). Local, never whole-file, so a desync stays local.
// =====================================================================================================================
const isId = (c) => c !== undefined && /[\w$]/.test(c);
function skipString(s, i) { const q = s[i]; i++; while (i < s.length) { const c = s[i]; if (c === '\\') { i += 2; continue; } if (c === q) return i + 1; i++; } return i; }
function skipTemplate(s, i) {
  i++;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') return i + 1;
    if (c === '$' && s[i + 1] === '{') { const e = scanBlock(s, i + 1); i = e < 0 ? s.length : e + 1; continue; }
    i++;
  }
  return i;
}
const REGEX_PREV = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'instanceof']);
function skipRegex(s, i) {
  i++; let cls = false;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '\n') return i;
    if (cls) { if (c === ']') cls = false; } else if (c === '[') cls = true; else if (c === '/') { i++; while (isId(s[i])) i++; return i; }
    i++;
  }
  return i;
}
function regexAllowedAt(s, i) {
  let j = i - 1; while (j >= 0 && (s[j] === ' ' || s[j] === '\n' || s[j] === '\t')) j--;
  if (j < 0) return true;
  const p = s[j];
  if (REGEX_PREV.has(p)) return true;
  if (isId(p)) { let k = j; while (k >= 0 && isId(s[k])) k--; return REGEX_AFTER_WORD.has(s.slice(k + 1, j + 1)); }
  return false;
}
/** s[open] is ( [ or {. visit(i, ch, depth) sees every code char inside (depth 0 = directly inside). Returns the matching closer index, -1, or -2 if visit stopped. */
function scanBlock(s, open, visit) {
  let depth = 0; let i = open + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") { i = skipString(s, i); continue; }
    if (c === '`') { i = skipTemplate(s, i); continue; }
    if (c === '/') {
      if (s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
      if (s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 2; continue; }
      if (regexAllowedAt(s, i)) { i = skipRegex(s, i); continue; }
    }
    if (c === '(' || c === '[' || c === '{') { if (visit && visit(i, c, depth)) return -2; depth++; i++; continue; }
    if (c === ')' || c === ']' || c === '}') { if (depth === 0) return i; depth--; if (visit && visit(i, c, depth)) return -2; i++; continue; }
    if (visit && visit(i, c, depth)) return -2;
    i++;
  }
  return -1;
}
/** Nearest enclosing opener of `kind` whose content directly contains idx (idx at depth 0). Backward bracket count, forward verification. */
function enclosingOpen(s, idx, kind = '{', maxBack = 3_000_000) {
  const closer = { '{': '}', '(': ')', '[': ']' }[kind];
  let depth = 0;
  for (let i = idx - 1; i >= 0 && i > idx - maxBack; i--) {
    const c = s[i];
    if (c === closer) depth++;
    else if (c === kind) {
      if (depth > 0) { depth--; continue; }
      let ok = null;
      const e = scanBlock(s, i, (j, ch, d) => { if (j >= idx) { ok = d === 0; return true; } return false; });
      if (ok === true) return i;
      if (ok === null && e > idx) return i;
      // not enclosing (desync or closed before idx): keep walking outward with a fresh depth
    }
  }
  return -1;
}
function exprEnd(s, i, end) {
  let depth = 0;
  while (i < end) {
    const c = s[i];
    if (c === '"' || c === "'") { i = skipString(s, i); continue; }
    if (c === '`') { i = skipTemplate(s, i); continue; }
    if (c === '/') {
      if (s[i + 1] === '/') { while (i < end && s[i] !== '\n') i++; continue; }
      if (s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? end : e + 2; continue; }
      if (regexAllowedAt(s, i)) { i = skipRegex(s, i); continue; }
    }
    if (c === '(' || c === '[' || c === '{') { depth++; i++; continue; }
    if (c === ')' || c === ']' || c === '}') { if (depth === 0) return i; depth--; i++; continue; }
    if (c === ',' && depth === 0) return i;
    i++;
  }
  return end;
}
const KEY_RE = /\s*(?:([A-Za-z_$][\w$]*)|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`([^`$]*)`)\s*([:(,}])/y;
/** Entries of the object literal at s[open]=='{': {kind:'prop'|'spread'|'method'|'shorthand'|'unknown', key, start, end, valueStart}. */
function objectEntries(s, open) {
  const close = scanBlock(s, open);
  if (close < 0) return null;
  const out = []; let i = open + 1;
  while (i < close) {
    while (i < close && /\s/.test(s[i])) i++;
    if (i >= close) break;
    const start = i;
    if (s.startsWith('...', i)) { const e = exprEnd(s, i + 3, close); out.push({ kind: 'spread', start, end: e, valueStart: i + 3 }); i = e + 1; continue; }
    KEY_RE.lastIndex = i;
    const m = KEY_RE.exec(s);
    if (!m) { const e = exprEnd(s, i, close); out.push({ kind: 'unknown', start, end: e }); i = e + 1; continue; }
    const key = m[1] ?? m[2] ?? m[3] ?? m[4];
    const after = i + m[0].length;
    if (m[5] === ':') { const e = exprEnd(s, after, close); out.push({ kind: 'prop', key, start, end: e, valueStart: after }); i = e + 1; }
    else if (m[5] === ',' || m[5] === '}') { out.push({ kind: 'shorthand', key, start, end: after - 1 }); i = after; }
    else { const e = exprEnd(s, after - 1, close); out.push({ kind: 'method', key, start, end: e, valueStart: after - 1 }); i = e + 1; }
  }
  return { entries: out, close };
}
/** Top-level elements of the array literal at s[open]=='[': [{start,end}]. */
function arrayElements(s, open) {
  const close = scanBlock(s, open);
  if (close < 0) return null;
  const out = []; let i = open + 1;
  while (i < close) {
    while (i < close && /\s/.test(s[i])) i++;
    if (i >= close) break;
    const e = exprEnd(s, i, close);
    out.push({ start: i, end: e }); i = e + 1;
  }
  return { elements: out, close };
}
/** Case labels of the switch body at s[open]=='{'. */
function switchLabels(s, open) {
  const labels = []; let dynamic = 0;
  const close = scanBlock(s, open, (i, c, d) => {
    if (d !== 0 || c !== 'c' || !s.startsWith('case', i) || isId(s[i - 1]) || isId(s[i + 4])) return false;
    let j = i + 4; while (/\s/.test(s[j])) j++;
    const q = s[j];
    if (q === '`') { const e = s.indexOf('`', j + 1); const v = s.slice(j + 1, e); if (!v.includes('${')) labels.push(v); else dynamic++; }
    else if (q === '"' || q === "'") { const e = skipString(s, j); labels.push(s.slice(j + 1, e - 1)); }
    else dynamic++;
    return false;
  });
  return { labels, dynamic, close };
}
const tpl = (v) => (v && v.length >= 2 && v[0] === '`' && v.at(-1) === '`' && !v.includes('${')) ? v.slice(1, -1) : (v && v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) ? v.slice(1, -1) : null;
const esc = (s) => s.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&');
/** Regex source of a string literal in any spelling a minifier writes: `x`, "x" or 'x' (22943's main process writes "x"; its renderer still writes `x`). */
const litRe = (s) => { const e = esc(s); return `(?:\`${e}\`|"${e}"|'${e}')`; };
const ID = '[A-Za-z_$][\\w$]*';
const uniq = (a) => [...new Set(a)];
const sorted = (a) => [...a].sort();
/** A string literal in each spelling the minifier uses (`x`, "x", 'x'; 22943 writes "x"): needles for a text search; `caseOf` the same for a switch label. */
const qs = (s) => ['`', '"', "'"].map((q) => `${q}${s}${q}`);
const caseOf = (s) => qs(s).map((x) => `case${x}:`);
const indexOfAny = (t, needles) => { let best = -1; for (const n of needles) { const i = t.indexOf(n); if (i >= 0 && (best < 0 || i < best)) best = i; } return best; };

// =====================================================================================================================
// 2. Corpus: lazily-read files of the extracted asar.
// =====================================================================================================================
class CensusError extends Error {}
/** Input: an extracted app.asar directory or the app.asar file itself (minimal read-only asar reader, same format as adapters/tools/asar.mjs). */
class DirSource {
  constructor(dir) { this.dir = dir; this.files = null; }
  list() {
    if (this.files) return this.files;
    const out = [];
    for (const sub of ['.vite/build', 'vite/build', 'webview/assets']) {
      const d = join(this.dir, sub); if (!existsSync(d)) continue;
      for (const f of readdirSync(d, { recursive: true })) { const p = `${sub}/${f}`; if (statSync(join(this.dir, p)).isFile()) out.push(p); }
    }
    return (this.files = out);
  }
  read(p) { return readFileSync(join(this.dir, p), 'utf8'); }
  size(p) { return statSync(join(this.dir, p)).size; }
}
export class AsarSource {
  constructor(file) {
    this.fd = openSync(file, 'r');
    const head = Buffer.alloc(16); readSync(this.fd, head, 0, 16, 0);
    const jsonLen = head.readUInt32LE(12); const hb = Buffer.alloc(jsonLen); readSync(this.fd, hb, 0, jsonLen, 16);
    this.base = 8 + head.readUInt32LE(4); this.map = new Map();
    const walk = (node, pre) => { for (const [n, c] of Object.entries(node.files ?? {})) { const p = pre ? `${pre}/${n}` : n; if (c.files) walk(c, p); else this.map.set(p, c); } };
    walk(JSON.parse(hb.toString('utf8')), '');
  }
  list() { return [...this.map.keys()]; }
  read(p) { const e = this.map.get(p); if (!e || e.unpacked) throw new CensusError(`asar: cannot read ${p}`); const b = Buffer.alloc(e.size); readSync(this.fd, b, 0, e.size, this.base + Number(e.offset)); return b.toString('utf8'); }
  size(p) { return this.map.get(p).size; }
}
class Corpus {
  constructor(src) {
    this.src = src; this.cache = new Map(); this.importerIndex = new Map();
    this.pkg = JSON.parse(src.read('package.json'));
    const all = src.list();
    const bp = all.some((p) => p.startsWith('.vite/build/')) ? '.vite/build/' : 'vite/build/';
    this.mainFiles = all.filter((p) => p.startsWith(bp) && p.endsWith('.js'));
    if (!this.mainFiles.length) throw new CensusError('input has no main-process bundle (.vite/build or vite/build)');
    const web = all.filter((p) => p.startsWith('webview/assets/') && p.endsWith('.js'));
    if (!web.length) throw new CensusError('input has no renderer chunks (webview/assets)');
    this.cssFiles = all.filter((p) => p.startsWith('webview/assets/') && p.endsWith('.css'));
    // Locale catalogs are per-language message tables. Candidates by shape (name `xx-YY-<hash>.js`, > 400 KB), accepted only when they carry the
    // catalog key "codex.command.newThread" (transient read; the i18n family re-reads only the pivot).
    this.localeFiles = []; this.localeKeyCount = new Map();
    const loc = new Set();
    for (const f of web) {
      if (!/\/[a-z]{2,3}(?:-[A-Za-z0-9]{2,4})?-[0-9a-f]{12}\.js$/.test(f) || src.size(f) <= 400_000) continue;
      const t = src.read(f);
      if (!t.includes(LOCALE_ANCHOR)) continue;
      loc.add(f); this.localeFiles.push(f);
      const d = /([\w$]+) as default/.exec(t.slice(t.lastIndexOf('export{')));
      const at = d ? t.lastIndexOf(`${d[1]}={`) : -1;
      this.localeKeyCount.set(f, at < 0 ? 0 : (t.slice(at).match(/[{,]"(?:[^"\\]|\\.)*":`/g) ?? []).length);
    }
    this.webFiles = web.filter((f) => !loc.has(f));
  }
  text(f) { let t = this.cache.get(f); if (t === undefined) { t = this.src.read(f); this.cache.set(f, t); } return t; }
  /** Files (of `files`) containing needle (or any of the alternative spellings, summed), with occurrence counts. */
  find(files, needle) {
    const out = []; const needles = Array.isArray(needle) ? needle : [needle];
    for (const f of files) {
      const t = this.text(f); let c = 0;
      for (const nd of needles) { let i = -1; while ((i = t.indexOf(nd, i + 1)) >= 0) c++; }
      if (c) out.push({ file: f, count: c });
    }
    return out;
  }
  /** Files (of `files`) where the global regex `re` matches: [{file, count, first}] (first = the first match, with .index). `needle` is a cheap substring prefilter. */
  findRe(files, re, needle) {
    const out = [];
    for (const f of files) {
      const t = this.text(f); if (needle && !t.includes(needle)) continue;
      const ms = [...t.matchAll(re)];
      if (ms.length) out.push({ file: f, count: ms.length, first: ms[0] });
    }
    return out;
  }
  /** Like `one`, for a regex: exactly one match in all of `files`; returns {file, index, text}. The spelling-agnostic form (the table may sit in any chunk, in any quote style). */
  oneRe(files, re, what, needle) {
    const hits = this.findRe(files, re, needle); const total = hits.reduce((a, h) => a + h.count, 0);
    if (total !== 1) throw new CensusError(`anchor ${what} (${re.source}) matched ${total} times in ${hits.length} files (expected 1 in 1): ${hits.map((h) => `${basename(h.file)}x${h.count}`).join(', ') || 'none'}`);
    return { file: hits[0].file, index: hits[0].first.index, text: hits[0].first[0] };
  }
  /** Exactly `n` total hits of needle (or of its alternative spellings together) across files, all in one file; returns that file. Fails loudly otherwise. */
  one(files, needle, what, n = 1) {
    const hits = this.find(files, needle); const total = hits.reduce((a, h) => a + h.count, 0);
    if (total !== n || hits.length !== 1) throw new CensusError(`anchor ${what} (${JSON.stringify(needle)}) matched ${total} times in ${hits.length} files (expected ${n} in 1): ${hits.map((h) => `${basename(h.file)}x${h.count}`).join(', ') || 'none'}`);
    return hits[0].file;
  }
}
const LOCALE_ANCHOR = '"codex.command.newThread":`';
const stem = (f) => basename(f).replace(/-(?![a-z]+\.)[0-9A-Za-z_-]{8,16}\.(js|css)$/, '').replace(/\.js$/, '');   // a word (`early-bootstrap.js`) is not a hash

// ---- alias chasing through rolldown's `export{local as name}` / `import{name as alias}from"./chunk.js"` (ESM webview) ----
const exportAliasCache = new Map();
function exportMap(C, file) {                       // local -> exported name
  if (exportAliasCache.has(file)) return exportAliasCache.get(file);
  const t = C.text(file); const m = new Map();
  const i = t.lastIndexOf('export{');
  if (i >= 0) { const e = t.indexOf('}', i); for (const x of t.slice(i + 7, e).split(',')) { const [a, b] = x.trim().split(/\s+as\s+/); if (a) m.set(a, b ?? a); } }
  exportAliasCache.set(file, m); return m;
}
/** imports of one chunk: alias -> {exported name, from file}. Static `import{a as b,...}from"./x.js"` statements at the head of the chunk. */
const importCache = new Map();
function importsOf(C, file) {
  if (importCache.has(file)) return importCache.get(file);
  const t = C.text(file); const head = t.slice(0, 400_000); const m = new Map();
  const byBase = C.__byBase ??= new Map(C.webFiles.map((f) => [basename(f), f]));
  for (const st of head.matchAll(/import\{([^}]*)\}from(["'])\.\/([^"']+)\2/g)) {   // either quote: the importer's spelling is the bundler's, not ours
    const from = byBase.get(st[3]); if (!from) continue;
    for (const x of st[1].split(',')) { const [a, b] = x.trim().split(/\s+as\s+/); if (a) m.set(b ?? a, { exported: a, from }); }
  }
  importCache.set(file, m); return m;
}
/** For every chunk importing `exporter`'s local `name` (and the exporter itself): [{file, alias}]. */
function aliasesOf(C, exporter, name) {
  const ex = exportMap(C, exporter).get(name);
  const out = [{ file: exporter, alias: name }];
  if (ex === undefined) return out;
  const idx = C.importerIndex.get(exporter) ?? (() => {
    const eb = basename(exporter); const m = new Map();
    for (const f of C.webFiles) { if (f === exporter) continue; const t = C.text(f); const head = t.slice(0, 400_000); if (head.indexOf(`}from"./${eb}"`) < 0 && head.indexOf(`}from'./${eb}'`) < 0) continue; for (const [alias, d] of importsOf(C, f)) if (d.from === exporter) { if (!m.has(d.exported)) m.set(d.exported, []); m.get(d.exported).push({ file: f, alias }); } }
    C.importerIndex.set(exporter, m); return m;
  })();
  return out.concat(idx.get(ex) ?? []);
}
/** Where `alias(` calls the binding it was chased to, in `file`: the import (or, in the exporting chunk `exporter`, the top-level declaration), not a local of the same name.
 *  A minifier reuses a short name in scopes that do not reference the module-level one (22943 composer-content: `E0t as bo` imported, `let bo=yo` a setter in a component).
 *  Cheap path: the name occurs only as a call head, a specifier of an import/export list, or (once, in the exporter) a `function name(` declaration; then every call head counts.
 *  Otherwise the file is parsed and each call head's binding looked up (js-shape: no local declaration found = the import; a top-level declaration in the exporter). -> indices of the call heads */
function callSites(C, file, alias, exporter) {
  const s = C.text(file); const heads = []; let suspicious = false; let decls = 0;
  for (const m of s.matchAll(new RegExp(`(?<![\\w$.])${esc(alias)}(?![\\w$])`, 'g'))) {
    const end = m.index + alias.length;
    if ((s.charCodeAt(end) | s.charCodeAt(m.index - 1)) > 127) continue;                // beside a non-ASCII char it is inside a string (a data table), not code
    if (s[end] === '(') { if (/function $/.test(s.slice(m.index - 9, m.index))) decls++; else heads.push(m.index); }
    else if (!(s.slice(m.index - 4, m.index) === ' as ' || s.startsWith(' as ', end))) suspicious = true;
  }
  if (decls > (file === exporter ? 1 : 0)) suspicious = true;
  if (!suspicious) return heads;
  const { shapeOf } = createRequire(import.meta.url)('./js-shape.mjs');          // lazy: acorn is only needed when a name is not plainly the import
  const sh = shapeOf(s); if (!sh) return heads;
  const callee = new Map(); for (const n of sh.all('CallExpression')) if (n.callee.type === 'Identifier' && n.callee.name === alias) callee.set(n.callee.start, n.callee);
  return heads.filter((i) => { const id = callee.get(i); if (!id) return true; const b = sh.binding(id); return b === null || (b.init != null && sh.enclosingFunction(b.init) === null); });
}
/** Unique top-level definition `IDENT=<rhs>` in file (or, if imported, in the exporting chunk). Returns {file, rhsStart} or null. */
function findDef(C, file, ident, depth = 0) {
  if (depth > 3 || !/^[A-Za-z_$][\w$]*$/.test(ident)) return null;
  const t = C.text(file);
  const chase = (imp) => { for (const [local, exported] of exportMap(C, imp.from)) if (exported === imp.exported) return findDef(C, imp.from, local, depth + 1); return null; };
  // a one-letter name in the chunk that uses it is an import alias (a local one is too common to follow); in the chunk that EXPORTS it (depth > 0) it is a top-level
  // definition: 22943 keeps a tiny constants chunk as `var t,n;function r(){return(r=e((()=>{t=`/merchants/settings`,n=`42`})))()}export{t as n,...}`
  if (ident.length < 2 && depth === 0) { const imp0 = importsOf(C, file).get(ident); return imp0 ? chase(imp0) : null; }
  const hits = [];
  const re = new RegExp(`(?<![\\w$.])${esc(ident)}=(?![=>])`, 'g');
  for (const m of t.matchAll(re)) hits.push(m.index + m[0].length);
  if (hits.length === 1) return { file, rhsStart: hits[0] };
  if (hits.length > 1) return null;
  const imp = importsOf(C, file).get(ident);
  return imp ? chase(imp) : null;
}
/** Static string value of an expression: template/string literal, const identifier, `${const}` template parts, `Enum.MEMBER`, `X.kind`. Null when unresolvable. */
function resolveStr(C, file, expr, depth = 0) {
  expr = expr.trim();
  if (depth > 5 || !expr) return null;
  const lit = tpl(expr); if (lit !== null) return lit;
  if (expr[0] === '`') {                              // template with ${ident} parts
    let out = ''; let i = 1;
    while (i < expr.length - 1) {
      if (expr[i] === '$' && expr[i + 1] === '{') { const e = scanBlock(expr, i + 1); const v = resolveStr(C, file, expr.slice(i + 2, e), depth + 1); if (v === null) return null; out += v; i = e + 1; }
      else { out += expr[i]; i++; }
    }
    return out;
  }
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(expr)) {   // enum member / descriptor member path: A.B, A.B.C
    const parts = expr.split('.');
    const d = findDef(C, file, parts[0]); if (!d) return null;
    const t = C.text(d.file); let at = d.rhsStart;
    for (const key of parts.slice(1)) {
      if (t[at] !== '{') return null;
      const oe = objectEntries(t, at); const p = oe?.entries.find((e) => e.key === key && e.kind === 'prop');
      if (!p) return null;
      at = p.valueStart; while (/\s/.test(t[at])) at++;
      if (key === parts.at(-1)) return resolveStr(C, d.file, t.slice(at, exprEnd(t, at, Math.min(t.length, at + 600))), depth + 1);
    }
    return null;
  }
  if (/^[A-Za-z_$][\w$]*$/.test(expr)) {
    const d = findDef(C, file, expr); if (!d) return null;
    const t = C.text(d.file); const e = exprEnd(t, d.rhsStart, Math.min(t.length, d.rhsStart + 400));
    return resolveStr(C, d.file, t.slice(d.rhsStart, e), depth + 1);
  }
  return null;
}

// =====================================================================================================================
// 3. Schema reader
// =====================================================================================================================
const CATEGORIES = ['ClientRequest', 'ServerRequest', 'ClientNotification', 'ServerNotification'];
function readSchema(dir) {
  const out = {};
  for (const cat of CATEGORIES) {
    const p = join(dir, `${cat}.json`);
    if (!existsSync(p)) throw new CensusError(`schema file missing: ${p}`);
    const j = JSON.parse(readFileSync(p, 'utf8'));
    if (!Array.isArray(j.oneOf)) throw new CensusError(`${p}: no oneOf[]`);
    out[cat] = j.oneOf.map((o, i) => { const m = o?.properties?.method?.enum?.[0]; if (typeof m !== 'string') throw new CensusError(`${p}: oneOf[${i}] has no properties.method.enum[0]`); return m; });
    const dup = out[cat].length - new Set(out[cat]).size; if (dup) throw new CensusError(`${p}: ${dup} duplicate method names`);
  }
  // A method's fingerprint: its params and, where the schema names one (`<X>Params` -> `<X>Response`), its result.
  const shared = {};
  for (const f of ['codex_app_server_protocol.schemas.json', 'codex_app_server_protocol.v2.schemas.json']) {
    if (existsSync(join(dir, f))) Object.assign(shared, JSON.parse(readFileSync(join(dir, f), 'utf8')).definitions ?? {});
  }
  const fingerprints = {};
  for (const cat of CATEGORIES) {
    const j = JSON.parse(readFileSync(join(dir, `${cat}.json`), 'utf8'));
    const defs = { ...shared, ...(j.definitions ?? {}) };
    for (const o of j.oneOf) {
      const params = o.properties?.params ?? null;
      const name = typeof params?.$ref === 'string' ? params.$ref.replace(/^#\/definitions\//, '') : null;
      const result = name && name.endsWith('Params') && cat.endsWith('Request') ? (defs[`${name.slice(0, -6)}Response`] ?? null) : null;
      fingerprints[`${cat}:${o.properties.method.enum[0]}`] = fingerprintOf({ params, result }, defs);
    }
  }
  let items = null;
  const v2 = join(dir, 'codex_app_server_protocol.v2.schemas.json');
  if (existsSync(v2)) { const j = JSON.parse(readFileSync(v2, 'utf8')); const ti = j.definitions?.ThreadItem; if (ti?.oneOf) items = ti.oneOf.map((o) => o.properties?.type?.enum?.[0]).filter(Boolean); }
  return { methods: out, threadItems: items, fingerprints };
}
/** A method's params and result schemas, their references inlined (a cycle named once), titles and descriptions left out, as a short
 *  hash: what a change of the method's shape changes (the feature log's `changed`, docs/design/systems.md "E4 in detail"). */
function fingerprintOf(node, defs) {
  const canon = (n, seen) => {
    if (Array.isArray(n)) return n.map((x) => canon(x, seen));
    if (n === null || typeof n !== 'object') return n;
    const ref = typeof n.$ref === 'string' ? /^#\/definitions\/(.+)$/.exec(n.$ref)?.[1] : null;
    if (ref) return seen.includes(ref) || !defs[ref] ? { $ref: ref } : canon(defs[ref], [...seen, ref]);
    const o = {};
    for (const k of Object.keys(n).sort()) if (k !== 'title' && k !== 'description') o[k] = canon(n[k], seen);
    return o;
  };
  return createHash('sha256').update(JSON.stringify(canon(node, []))).digest('hex').slice(0, 16);
}

// =====================================================================================================================
// 4. Families. Each returns {anchor, files:[role strings], count, values, ...extras}. Throwing CensusError = fail loudly.
// =====================================================================================================================
const fam = {};
const role = (C, f) => `${f.startsWith('webview/') ? 'renderer' : 'main-process'}:${stem(f)}`;

// ---- shared locators (memoised) ----
const memo = new Map();
const once = (k, fn) => { if (!memo.has(k)) memo.set(k, fn()); return memo.get(k); };
const mainFile = (C) => once('main', () => C.one(C.mainFiles, caseOf('shared-object-set'), 'main bundle (per-window message switch)'));
/** The renderer chunk with the command table (`app-initial` through 21477; `app-shared` on 22943): only commands.ids reads it, the other families find their own chunk by what it holds. */
const commandChunk = (C) => once('commandChunk', () => C.one(C.webFiles, '[{id:`newTask`,titleIntlId:', 'command table chunk'));
const appShared = (C) => once('appShared', () => C.one(C.webFiles, 'e.useSyncExternalStore=function', 'app-shared chunk (React CJS wrapper)'));
const lastWithin = (t, re, from, to) => { let last = null; for (const m of t.slice(from, to).matchAll(re)) last = m; return last; };

/** Body `{` index of the function declared by regex match `d` (whose text ends with `(`): skips the parameter list structurally. */
function bodyOpenOf(t, d) { const po = d.index + d[0].length - 1; const pc = scanBlock(t, po); return pc < 0 ? -1 : t.indexOf('{', pc); }
/** The type tests a short piece of code makes on a message variable `v` (any variable when omitted): `v.type.startsWith(P)` -> prefixes {value, start}, `v.type===X` and `X===v.type` -> types. Any quote spelling. */
function typeTests(s, v) {
  const x = v ? `(?<![\\w$.])${esc(v)}` : '(?<![\\w$.])[\\w$]+'; const prefixes = []; const types = [];
  for (const m of s.matchAll(new RegExp(`${x}\\.type\\.startsWith\\((["'\`])([^"'\`]+)\\1\\)`, 'g'))) prefixes.push({ value: m[2], start: m.index });
  for (const m of s.matchAll(new RegExp(`${x}\\.type===(["'\`])([^"'\`]+)\\1`, 'g'))) types.push(m[2]);
  for (const m of s.matchAll(new RegExp(`(["'\`])([^"'\`]+)\\1===${x}\\.type`, 'g'))) types.push(m[2]);
  return { prefixes, types };
}
/** Type guards in a handler preamble (the statements before its switch). A guard is a call of a function that only tests the type (`if(!g(e))` -> `function g(e){return e.type.startsWith(P)}` or `…===X`), and, with `v` (the
 *  switch's message variable), the same test written in place (`if(t.type.startsWith("P"))`, `"X"===t.type`; 22943 inlines both). -> {prefixes, types, byName, guards: [{prefix, name | start}]} */
function preambleGuards(t, pre, v) {
  const prefixes = []; const types = []; const byName = {}; const guards = [];
  for (const call of uniq([...pre.matchAll(/(?<![\w$.])(?:if\(!?)?([A-Za-z_$][\w$]*)\([\w$]+\)/g)].map((m) => m[1]))) {
    for (const d of t.matchAll(new RegExp(`function ${esc(call)}\\(([\\w$]+)\\)\\{return\\s*`, 'g'))) {
      const e = scanBlock(t, d.index + d[0].lastIndexOf('{'));
      const g = e < 0 || e - d.index > 300 ? null : typeTests(t.slice(d.index + d[0].length, e), d[1]);   // a guard's body is one short `return` of type tests
      if (!g || !(g.prefixes.length || g.types.length)) continue;
      for (const p of g.prefixes) { prefixes.push(p.value); byName[call] = p.value; guards.push({ prefix: p.value, name: call }); }
      types.push(...g.types);
      break;
    }
  }
  if (v) { const g = typeTests(pre, v); for (const p of g.prefixes) { prefixes.push(p.value); guards.push({ prefix: p.value, start: p.start }); } types.push(...g.types); }
  return { prefixes: uniq(prefixes), types: uniq(types), byName, guards };
}
/** The preamble of the switch whose body is at t[open]: the statements of the function around it, before the switch, and the message variable it switches on. */
function switchPreamble(t, open) {
  const v = /switch\(([\w$]+)\.type\)$/.exec(t.slice(Math.max(0, open - 40), open))?.[1] ?? null;
  const body = enclosingOpen(t, open);
  return { v, pre: body >= 0 && open - body < 4000 ? t.slice(body, open) : '' };
}
/** The labels of the switch that a prefix guard hands its messages to: `if(guard(e)){await fn(…)}` or inline `if(t.type.startsWith(P))return void await fn(…)`, `function fn(…){switch(x.type){case P…`. */
function prefixDelegates(t, pre, guards) {
  const out = [];
  for (const g of guards) {
    const at = g.name ? (() => { const m = new RegExp(`if\\(${esc(g.name)}\\(\\w+\\)\\)`).exec(pre); return m ? m.index + m[0].length : -1; })()
      : (() => { const i = pre.lastIndexOf('if(', g.start); const c = i < 0 ? -1 : scanBlock(pre, i + 2); return c < 0 ? -1 : c + 1; })();   // just after the `if(…)` condition
    const m = at < 0 ? null : /^(?:\{|\s|(?:return|void|await)\s+)*(?!(?:switch|if|return|void|await)\b)([A-Za-z_$][\w$]*)\(/.exec(pre.slice(at, at + 200));
    if (!m) continue;
    for (const d of t.matchAll(new RegExp(`function ${esc(m[1])}\\(`, 'g'))) {
      const b = bodyOpenOf(t, d); const sw2 = b < 0 ? -1 : t.indexOf('switch(', b);
      if (sw2 < 0 || sw2 > b + 40) continue;
      out.push(...switchLabels(t, t.indexOf('{', sw2)).labels.filter((x) => x.startsWith(g.prefix)));
      break;
    }
  }
  return out;
}
/** Webpack module id (`35575(e,t,r){…}`, an entry of a chunk's modules) that holds t[idx]; null when none. */
function webpackModuleId(t, idx) {
  const heads = [...t.slice(0, idx).matchAll(/(?<=[,{])(\d+)\([\w$]+(?:,[\w$]+){0,2}\)\{/g)].slice(-6);
  for (let k = heads.length - 1; k >= 0; k--) { const h = heads[k]; const e = scanBlock(t, h.index + h[0].length - 1); if (e > idx) return h[1]; }
  return null;
}
/** How the main process spells an exported string constant (an IPC channel): every {file, local, member, def} such that `local.member` in `file` is `value`. The defining module either exports it
 *  (`NAME=`value`` + `exports.m=NAME`; importer `L=require("./def.js")`, 21477) or lists it among a webpack module's constants (`87329(e,t,n){…n.d(t,{…},{m:"value"})}`; importer `L=r(87329)`, 22943). */
function constRefs(C, value) {
  const refs = new Map(); const add = (r) => refs.set(`${r.file}|${r.local}|${r.member}`, r);
  for (const needle of qs(value)) for (const h of C.find(C.mainFiles, needle)) {
    const t = C.text(h.file);
    for (let i = t.indexOf(needle); i >= 0; i = t.indexOf(needle, i + 1)) {
      const before = t.slice(Math.max(0, i - 80), i);
      const nm = new RegExp(`(?<![\\w$.])(${ID})=$`).exec(before); const mem = nm ? null : /[{,]([A-Za-z_$][\w$]*):$/.exec(before);
      if (nm) {
        for (const ex of t.matchAll(new RegExp(`exports\\.(${ID})=${esc(nm[1])}[,;]`, 'g'))) for (const g of C.mainFiles) for (const im of C.text(g).matchAll(new RegExp(`(${ID})=require\\(["'\`]\\./${esc(basename(h.file))}["'\`]\\)`, 'g'))) add({ file: g, local: im[1], member: ex[1], def: h.file });
      } else if (mem) {
        const id = webpackModuleId(t, i);
        if (id) for (const g of C.mainFiles) for (const im of C.text(g).matchAll(new RegExp(`(?<![\\w$.])(${ID})=${ID}\\(${id}\\)[,;]`, 'g'))) add({ file: g, local: im[1], member: mem[1], def: h.file });
      }
    }
  }
  return [...refs.values()];
}
/** The function literal at t[at] (`async(e,t)=>{`, `function(e,t){`): {body: index of its `{`, param: its second parameter's name or null}; null for another shape. */
function callbackOf(t, at) {
  const m = /^\s*(?:async\s*)?(?:function\s*)?\(/.exec(t.slice(at, at + 40)); if (!m) return null;
  const po = at + m[0].length - 1; const pc = scanBlock(t, po); if (pc < 0) return null;
  const b = /^\s*(?:=>)?\s*\{/.exec(t.slice(pc + 1, pc + 12)); if (!b) return null;
  const second = t.slice(po + 1, pc).split(',')[1]?.trim() ?? '';
  return { body: pc + 1 + b[0].length - 1, param: /^[A-Za-z_$][\w$]*$/.test(second) ? second : null };
}

// ---- 1. bus ------------------------------------------------------------------------------------------------------
fam['bus.fromView'] = (C) => {
  const f = mainFile(C); const t = C.text(f);
  const idx = indexOfAny(t, caseOf('shared-object-set'));
  const open = enclosingOpen(t, idx);
  if (!/switch\([\w$]+\.type\)$/.test(t.slice(open - 24, open))) throw new CensusError('bus.fromView: enclosing block of case`shared-object-set` is not a `switch(x.type)`');
  const sw = switchLabels(t, open);
  if (sw.labels.length < 50) throw new CensusError(`bus.fromView: per-window switch has only ${sw.labels.length} labels`);
  // preamble of the per-window handleMessage: guards before the switch (avatar-overlay-* prefix family; 21477 calls a guard function, 22943 writes the test in place)
  const { v: msgVar, pre } = switchPreamble(t, open);
  const g1 = preambleGuards(t, pre, msgVar);
  // prefix-guarded delegate: `if(guard(n)){await fn(...)}` -> the labels of fn's own switch(x.type) that carry the prefix
  const delegated = prefixDelegates(t, pre, g1.guards);
  if (g1.prefixes.length && !delegated.length) throw new CensusError(`bus.fromView: the prefix guard ${JSON.stringify(g1.prefixes)} of the per-window handler hands its messages to a function whose switch could not be read`);
  // front door: ipcMain.handle(<message-from-view channel>, ...). The channel constant is resolved through the module that exports it.
  const CHANNEL = 'codex_desktop:message-from-view';
  const refs = constRefs(C, CHANNEL);
  if (!refs.length) throw new CensusError('bus.fromView: cannot resolve the message-from-view channel constant through the IPC module exports');
  const fd = [];
  for (const r of refs) for (const m of C.text(r.file).matchAll(new RegExp(`ipcMain\\.handle\\(${esc(r.local)}\\.${esc(r.member)},`, 'g'))) fd.push({ file: r.file, at: m.index + m[0].length });
  if (fd.length !== 1) throw new CensusError(`bus.fromView: front-door ipcMain.handle(message-from-view) matched ${fd.length} times`);
  const ft = C.text(fd[0].file); const cb = callbackOf(ft, fd[0].at);
  if (!cb) throw new CensusError('bus.fromView: the front-door handler is not a function literal');
  const frontBody = ft.slice(cb.body, scanBlock(ft, cb.body));
  const frontDoor = uniq(typeTests(frontBody, cb.param ?? undefined).types);
  const g2 = preambleGuards(ft, frontBody);
  // delegate handlers that begin `handleMessage(e,t){if(!guard(t))return!1;` with guard = `e.type in MAP` (global dictation), called or written in place (`if(!(t.type in MAP))return!1;`)
  const inMap = [];
  for (const mf of C.mainFiles) {
    const mt = C.text(mf); if (!mt.includes('handleMessage(')) continue;
    for (const m of mt.matchAll(new RegExp(`handleMessage\\((${ID}),(${ID})\\)\\{if\\(!(?:\\(\\2\\.type in (${ID})\\)|(${ID})\\(\\2\\))\\)return!1;`, 'g'))) {
      const map = m[3] ?? new RegExp(`function ${esc(m[4])}\\((${ID})\\)\\{return\\s*\\1\\.type in (${ID})\\}`).exec(mt)?.[2];
      const mi = map && lastWithin(mt, new RegExp(`(?<![\\w$.])${esc(map)}=\\{`, 'g'), 0, m.index);
      if (!mi) continue;
      const oe = objectEntries(mt, mi.index + mi[0].length - 1);
      if (oe) inMap.push(...oe.entries.filter((e) => e.key).map((e) => e.key));
    }
  }
  const values = sorted(uniq([...sw.labels, ...frontDoor, ...g1.types, ...g2.types, ...inMap, ...delegated]));
  const sw_ = new Set(sw.labels);
  // cross-check: every literal the renderer posts with `<bus>.dispatchMessage(`type`,...)` must be a handled type
  const sent = new Set();
  for (const w of C.webFiles) { const wt = C.text(w); if (!wt.includes('.dispatchMessage(')) continue; for (const m of wt.matchAll(/\.dispatchMessage\((["'`])([^"'`$]+)\1/g)) sent.add(m[2]); }
  const handled = new Set(values);
  return {
    anchor: 'switch(x.type) enclosing case`shared-object-set`: (per-window handleMessage; exhaustive over the union) + ipcMain.handle(<message-from-view const>) front-door `.type===` chain + preamble type-guard delegates (+ `e.type in MAP` delegate handler); quote spelling and chunk of each part are free',
    files: uniq([role(C, f), role(C, fd[0].file), ...refs.map((r) => role(C, r.def))]), anchorHits: { 'case`shared-object-set`': 1, 'ipcMain.handle(message-from-view)': 1 },
    count: values.length, values,
    parts: { perWindowSwitch: sw.labels.length, perWindowSwitchDynamicLabels: sw.dynamic, frontDoor: frontDoor.length, frontDoorNotInSwitch: frontDoor.filter((x) => !sw_.has(x)), guardTypes: uniq([...g1.types, ...g2.types]), guardTypesNotInSwitch: uniq([...g1.types, ...g2.types]).filter((x) => !sw_.has(x)), typeInMapDelegate: uniq(inMap).length, typeInMapNotInSwitch: uniq(inMap).filter((x) => !sw_.has(x)), prefixDelegateTypes: uniq(delegated) },
    prefixDelegates: uniq([...g1.prefixes, ...g2.prefixes]).map((p) => `${p}*`),
    crossCheck: { rendererDispatchMessageLiterals: sent.size, notInHandledSet: [...sent].filter((x) => !handled.has(x)).sort() },
    falsePositiveRisk: 'delegates reached only through a startsWith-guard (avatar-overlay-*) are a prefix family, not enumerated; a new delegate shape is silently missed (see renderer-sent cross-check)',
  };
};

fam['bus.toView'] = (C) => {
  // the renderer's message-for-view dispatcher: located by its case label, wherever the chunk is (app-initial in 20770/21477, the lazy initialize-app-host-services chunk in 22943)
  const f = C.one(C.webFiles, caseOf('persisted-atom-updated'), 'renderer message-for-view dispatcher (case`persisted-atom-updated`)');
  const t = C.text(f);
  const idx = indexOfAny(t, caseOf('persisted-atom-updated'));
  const open = enclosingOpen(t, idx);
  if (!/switch\([\w$]+\.type\)$/.test(t.slice(open - 24, open))) throw new CensusError('bus.toView: enclosing block is not a switch(x.type)');
  const sw = switchLabels(t, open);
  if (sw.labels.length < 100) throw new CensusError(`bus.toView: renderer switch has only ${sw.labels.length} labels`);
  const { v: msgVar, pre } = switchPreamble(t, open);
  const g = preambleGuards(t, pre, msgVar);
  // dynamic labels `case Enum.MEMBER:` resolved through their enum object
  const dynResolved = []; const dynUnresolved = [];
  scanBlock(t, open, (j, c, d) => {
    if (d !== 0 || c !== 'c' || !t.startsWith('case', j) || isId(t[j - 1]) || isId(t[j + 4])) return false;
    const k = j + 4; const m = /^\s*([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*):/.exec(t.slice(k, k + 80));
    if (m) { const v = resolveStr(C, f, m[1]); (v ? dynResolved : dynUnresolved).push(v ?? m[1]); }
    return false;
  });
  // cross-check: types main sends by literal (the main process is one bundle in 21477, webpack chunks in 22943: every main-process file)
  const sent = uniq(C.mainFiles.flatMap((mf) => [...C.text(mf).matchAll(/\.send(?:MessageTo(?:WebContents|WebContentsId|Window|AllWindows|AllRegisteredWindows|View|Origin)|InlineMessageForView)\([^;{}]{0,120}?\{type:(["'`])([^"'`$]+)\1/g)].map((x) => x[2])));
  const values = sorted(uniq([...sw.labels, ...g.types, ...dynResolved]));
  const notInSwitch = sent.filter((s) => !values.includes(s));
  return {
    anchor: 'switch(x.type) enclosing case`persisted-atom-updated`: in the one renderer chunk that has it (the renderer message-for-view dispatcher; exhaustive, no-op cases listed) + preamble type-guard + enum-member labels',
    files: [role(C, f)], anchorHits: { 'case`persisted-atom-updated`': 1 },
    count: values.length, values,
    parts: { switchLabels: sw.labels.length, guardTypes: g.types, enumMemberLabels: dynResolved, enumMemberLabelsUnresolved: dynUnresolved },
    crossCheck: { mainLiteralSends: sent.length, mainLiteralSendsNotInRendererSet: notInSwitch },
    falsePositiveRisk: 'labels that are explicit no-ops (break) are types the renderer receives but handles through another subscriber',
  };
};

/** The class body `{` that encloses idx: the nearest enclosing brace whose head reads `class [Name] [extends X]`; -1 when none within a few levels. */
function enclosingClassBody(t, idx) {
  let at = idx;
  for (let hop = 0; hop < 8; hop++) {
    const open = enclosingOpen(t, at, '{');
    if (open < 0) return -1;
    if (/(?<![\w$.])class(?:\s+[A-Za-z_$][\w$]*)?(?:\s+extends\s+[^{;]{1,120})?\s*$/.test(t.slice(Math.max(0, open - 200), open))) return open;
    at = open;
  }
  return -1;
}
/** Anchor of the fetch handler map: the dispatcher's own failure text (20770 had `automation-create` as a key; 21477 moved most handlers to the AppHost services and no longer has it; 22943 keeps one). */
const FETCH_DISPATCH = 'not implemented in the current Electron process';
fam['bus.fetchHandlers'] = (C) => {
  const f = C.one(C.mainFiles, FETCH_DISPATCH, 'main bundle (fetch handler dispatcher)');
  const t = C.text(f); const i = t.indexOf(FETCH_DISPATCH);
  if (!/this\.handlers\[[\w$]+\]/.test(t.slice(Math.max(0, i - 200), i))) throw new CensusError('bus.fetchHandlers: the dispatcher does not look its handler up in this.handlers[...]');
  const cls = enclosingClassBody(t, i);
  if (cls < 0) throw new CensusError('bus.fetchHandlers: the dispatcher is not inside a class body');
  const fields = [];
  scanBlock(t, cls, (j, c, d) => { if (d === 0 && c === 'h' && t.startsWith('handlers={', j) && !isId(t[j - 1]) && t[j - 1] !== '.') fields.push(j + 9); return false; });
  if (fields.length !== 1) throw new CensusError(`bus.fetchHandlers: the dispatcher's class has ${fields.length} \`handlers={...}\` fields (expected 1)`);
  const oe = objectEntries(t, fields[0]);
  // the map shrinks as handlers move to the AppHost services (131 in 20770, 37 in 21477, 1 in 22943): the dispatcher and the unique field are the structure, the size is data
  if (!oe || !oe.entries.length) throw new CensusError(`bus.fetchHandlers: the handler object has ${oe?.entries.length} entries`);
  const unknown = oe.entries.filter((e) => e.kind === 'unknown');
  if (unknown.length) throw new CensusError(`bus.fetchHandlers: ${unknown.length} entries of the handler object are neither keys nor spreads`);
  const keys = oe.entries.filter((e) => e.key && e.kind !== 'spread').map((e) => e.key);
  const spreads = oe.entries.filter((e) => e.kind === 'spread').map((e) => ({ expr: t.slice(e.start, Math.min(e.end, e.start + 40)), ...spreadKeys(t, t.slice(e.valueStart, e.end)) }));
  const all = sorted(uniq([...keys, ...spreads.flatMap((s) => s.keys)]));
  const dups = keys.length - new Set(keys).size;
  return {
    anchor: `the class body that holds the dispatcher ("${FETCH_DISPATCH}", which reads this.handlers[name]): its one field \`handlers={...}\` (the vscode://codex/<name> fetch handlers), plus \`...fn()\` spreads resolved through their declaration`,
    files: [role(C, f)], anchorHits: { [FETCH_DISPATCH]: 1, 'handlers={ field': 1 },
    count: all.length, values: all,
    parts: { literalKeys: keys.length, duplicateLiteralKeys: dups, spreads: spreads.map((s) => ({ expr: s.expr, keys: s.keys, note: s.note })) },
    falsePositiveRisk: 'handlers registered by assignment after construction (handlers[x]=...) would be missed; none seen. Names are the URL tail of vscode://codex/<name>. A build that moves handlers to another dispatcher (21477 moved most to AppHost services, 22943 all but one) lists only what stayed; the moved ones are no longer addressable by name here (see apphost.services)',
  };
};
/** Top-level positions of the chars in `chars` within t[i,end): outside strings, templates, regexes, comments and brackets. */
function topLevelAt(t, i, end, chars) {
  const out = []; let depth = 0;
  while (i < end) {
    const c = t[i];
    if (c === '"' || c === "'") { i = skipString(t, i); continue; }
    if (c === '`') { i = skipTemplate(t, i); continue; }
    if (c === '/') {
      if (t[i + 1] === '/') { while (i < end && t[i] !== '\n') i++; continue; }
      if (t[i + 1] === '*') { const e = t.indexOf('*/', i + 2); i = e < 0 ? end : e + 2; continue; }
      if (regexAllowedAt(t, i)) { i = skipRegex(t, i); continue; }
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && chars.includes(c)) out.push(i);
    i++;
  }
  return out;
}
/** The expression a function returns: t[b]=='{' opens its body; the last top-level `return`, its last comma-separated segment (`return a,b,{...}`). Null when there is none. */
function returnedExpr(t, b) {
  const e = scanBlock(t, b); if (e < 0) return null;
  let ret = null; scanBlock(t, b, (j, c, depth) => { if (depth === 0 && c === 'r' && t.startsWith('return', j) && !isId(t[j - 1]) && !isId(t[j + 6])) ret = j + 6; return false; });
  if (ret === null) return null;
  let i = ret; let last = null;                          // last top-level comma-separated segment of the return expression
  while (i < e) { while (/\s/.test(t[i])) i++; const x = exprEnd(t, i, e); last = i; if (x >= e) break; i = x + 1; }
  return last === null ? null : t.slice(last, e);
}
/** Keys an expression contributes when it is spread into an object literal (`...expr`) -> {keys, conditional, note}. The expression is read by what it evaluates to:
 *  an object literal; `(a,b,{...})` (the last of a sequence); `c?{...}:{...}` (every key conditional); a call whose function's return ends in one of those: `fn(args)`
 *  (function declaration), `a.b.fn(args)` (the one method `fn(...){...}`), `function(...){...}(args)` (an IIFE); a name bound once at the top level of `scope`
 *  (`k=<expr>` in the method body). 20770/21477 spread `...fn(args)`; 22943's minifier inlined the single-use functions, so the same objects arrive in the other forms. */
function spreadKeys(t, text, scope = null, hops = 0) {
  const x = text.trim().replace(/;$/, '');
  const unresolved = (what) => ({ keys: [], note: `${what} ${x.slice(0, 40)}` });
  if (hops > 6) return unresolved('spread nested too deep');
  const sub = (s) => spreadKeys(t, s, scope, hops + 1);
  const ofReturn = (b, name) => {                         // the keys of what the function body at t[b] returns
    if (b < 0) return { keys: [], note: `no body for ${name}` };
    const r = returnedExpr(t, b); if (r === null) return { keys: [], note: `no return in ${name}` };
    const k = sub(r); return k.keys.length || !k.note ? k : { keys: [], note: `return of ${name} does not end in an object literal` };
  };
  if (x[0] === '{') {
    const oe = objectEntries(x, 0); if (!oe) return unresolved('unbalanced object');
    const keys = []; const conditional = []; let note;
    for (const en of oe.entries) {
      if (en.key) keys.push(en.key);
      else if (en.kind === 'spread') { const r = sub(x.slice(en.valueStart, en.end)); keys.push(...r.keys); conditional.push(...(r.conditional ?? [])); note ??= r.note; }
    }
    return { keys, conditional, ...(note ? { note } : {}) };
  }
  if (x[0] === '(' && scanBlock(x, 0) === x.length - 1) {            // a parenthesised sequence: its value is the last element
    const inner = x.slice(1, -1); const commas = topLevelAt(inner, 0, inner.length, ',');
    return sub(commas.length ? inner.slice(commas.at(-1) + 1) : inner);
  }
  const and = topLevelAt(x, 0, x.length, '&').find((i) => x[i + 1] === '&' && x[i - 1] !== '&');   // cond&&{...}: the object is conditional
  if (and !== undefined && topLevelAt(x, 0, x.length, '?').length === 0) { const r = sub(x.slice(and + 2)); return { keys: r.keys, conditional: r.keys, ...(r.note ? { note: r.note } : {}) }; }
  const q = topLevelAt(x, 0, x.length, '?:').filter((i) => !(x[i] === '?' && (x[i + 1] === '.' && !/\d/.test(x[i + 2] ?? '') || x[i + 1] === '?' || x[i - 1] === '?')));
  if (q.length >= 2 && x[q[0]] === '?') {                            // cond ? A : B
    let nest = 0; let colon = -1;
    for (const i of q.slice(1)) { if (x[i] === '?') nest++; else if (nest === 0) { colon = i; break; } else nest--; }
    if (colon > 0) {
      const a = sub(x.slice(q[0] + 1, colon)); const b = sub(x.slice(colon + 1));
      const keys = [...a.keys, ...b.keys]; return { keys, conditional: keys, ...((a.note ?? b.note) ? { note: a.note ?? b.note } : {}) };
    }
  }
  if (/^function\b/.test(x)) {                                       // (function(params){body})(args): the callee itself
    const po = x.indexOf('('); const pc = po < 0 ? -1 : scanBlock(x, po); const bo = pc < 0 ? -1 : x.indexOf('{', pc);
    if (bo < 0) return unresolved('unreadable function');
    const r = returnedExpr(x, bo); if (r === null) return { keys: [], note: `no return in ${x.slice(0, 20)}` };
    return sub(r);
  }
  if (/^[A-Za-z_$][\w$]*$/.test(x) && scope) {                       // a name bound once at the top level of the method body
    const hits = [];
    scanBlock(scope, 0, (j, c, d) => { if (d === 0 && c === x[0] && scope.startsWith(`${x}=`, j) && !isId(scope[j - 1]) && scope[j - 1] !== '.' && !/[=>]/.test(scope[j + x.length + 1])) hits.push(j + x.length + 1); return false; });
    if (hits.length !== 1) return unresolved(hits.length ? 'ambiguous binding' : 'unbound name');
    return sub(scope.slice(hits[0], exprEnd(scope, hits[0], scope.length)));
  }
  const m = /^((?:[A-Za-z_$][\w$]*\.)*)([A-Za-z_$][\w$]*)\(/.exec(x);
  if (!m || scanBlock(x, m[0].length - 1) !== x.length - 1) return unresolved('non-call spread');
  if (!m[1]) {                                                       // fn(args): the function declaration
    const d = new RegExp(`function ${esc(m[2])}\\(`).exec(t);
    if (!d) return { keys: [], note: `no declaration for ${m[2]}` };
    return ofReturn(bodyOpenOf(t, d), m[2]);
  }
  const defs = [];                                                   // a.b.fn(args): the one method definition `fn(...){...}`
  for (const d of t.matchAll(new RegExp(`(?<![\\w$.])${esc(m[2])}\\(`, 'g'))) {
    const pc = scanBlock(t, d.index + d[0].length - 1);
    if (pc > 0 && t[pc + 1] === '{' && /(?:[{};,]|\b(?:async|static))\s*$/.test(t.slice(Math.max(0, d.index - 12), d.index))) defs.push(pc + 1);
  }
  if (defs.length !== 1) return { keys: [], note: `${defs.length} definitions of method ${m[2]}` };
  return ofReturn(defs[0], m[2]);
}

fam['ipc.channels'] = (C) => {
  const found = new Map();
  for (const f of C.mainFiles) {
    const t = C.text(f);
    for (const m of t.matchAll(/([`"'])(codex_desktop:[A-Za-z0-9_:\-${}.]*)\1/g)) { if (!found.has(m[2])) found.set(m[2], new Set()); found.get(m[2]).add(role(C, f)); }
  }
  for (const need of ['codex_desktop:message-from-view', 'codex_desktop:message-for-view', 'codex_desktop:connect-app-host']) if (!found.has(need)) throw new CensusError(`ipc.channels: ${need} not found`);
  const values = sorted([...found.keys()]);
  return {
    anchor: 'string literals `codex_desktop:<name>` (colon form) in vite/build files; `${}` segments mark per-worker channels',
    files: uniq([...found.values()].flatMap((s) => [...s])).sort(), anchorHits: { 'codex_desktop:*': values.length },
    count: values.length, values,
    dynamic: values.filter((v) => v.includes('${')),
    falsePositiveRisk: 'underscore forms (codex_desktop_quic_ssh, ...) are gate/feature names, excluded by the colon; a channel built by concatenation would be missed',
  };
};

// ---- 2. state ----------------------------------------------------------------------------------------------------
fam['state.globalKeys'] = (C) => {
  // The enum of global-state keys, found by its member LOCAL_PROJECTS:<"local-projects"> in any quote. It lives in the shared lib and every realm
  // bundles its own copy: 20770 and 21477 have two renderer chunks and two main-process files (shared lib, worker) with one each; 22943's
  // webpack main process shares one copy through its module graph (early-bootstrap.js) and the worker has none. So the demand is a copy in each
  // realm and at most one per file, all equal, not a fixed number.
  const anchor = 'LOCAL_PROJECTS:<"local-projects">';
  const re = /\bLOCAL_PROJECTS:(["'`])local-projects\1/g;
  const copies = (files) => files.flatMap((f) => { const t = C.text(f); return t.includes('LOCAL_PROJECTS:') ? [...t.matchAll(re)].map((m) => ({ file: f, at: m.index })) : []; });
  const rend = copies(C.webFiles); const main_ = copies(C.mainFiles);
  const tally = (hs) => JSON.stringify(uniq(hs.map((h) => h.file)).map((x) => basename(x) + 'x' + hs.filter((h) => h.file === x).length));
  if (!rend.length || !main_.length || [...rend, ...main_].some((h, _, all) => all.some((o) => o !== h && o.file === h.file))) throw new CensusError(`state.globalKeys: anchor ${anchor} matched renderer ${tally(rend)} main ${tally(main_)} (expected a copy in each realm and one per file: the enum ships in the shared lib and is bundled into each realm)`);
  const parse = ({ file, at }) => {
    const t = C.text(file); const open = enclosingOpen(t, at); const oe = objectEntries(t, open);
    if (!oe || oe.entries.length < 30) throw new CensusError(`state.globalKeys: enum in ${file} has ${oe?.entries.length} entries`);
    const map = {}; for (const e of oe.entries) { if (e.kind !== 'prop') continue; const v = tpl(t.slice(e.valueStart, e.end)); if (v !== null) map[e.key] = v; }
    return map;
  };
  const maps = [...rend, ...main_].map(parse);
  const same = maps.every((m) => JSON.stringify(m) === JSON.stringify(maps[0]));
  const values = sorted(Object.values(maps[0]));
  return {
    anchor: 'object literal containing LOCAL_PROJECTS:<"local-projects"> (enum NAME:"value", any quote); one copy per bundled file: the app-shared chunk and a display worker chunk in the renderer, the shared lib (and, before 22943, the worker bundle) in the main process',
    files: [...rend, ...main_].map((h) => role(C, h.file)), anchorHits: { [anchor]: rend.length + main_.length },
    count: values.length, values, enumNames: Object.keys(maps[0]).length,
    crossCheck: { allCopiesEqual: same, counts: maps.map((m) => Object.keys(m).length), renderer: rend.length, mainProcess: main_.length },
    falsePositiveRisk: 'enum members whose value is not a plain string literal would be skipped (none)',
  };
};

/** The persisted-atom factories, located by their shape in whichever renderer chunk declares them (not by a role chunk: the command table, the
 *  React wrapper and these factories each moved between app-initial and app-shared across builds). Param names are captured and cross-checked
 *  by back-reference, not assumed.
 *  static: `function F(key,initial,options){R({initialValue:initial,key});...`    keyed: `function K(keyOf,initial){let a=W(S,n=>V(keyOf(n),initial),{getServerSnapshot:()=>initial,onMount(...` */
const STATIC_FACTORY_RE = new RegExp(`function (${ID})\\((${ID}),(${ID}),(${ID})\\)\\{(${ID})\\(\\{(?:initialValue:\\3,key:\\2|key:\\2,initialValue:\\3)\\}\\);`, 'g');
const KEYED_FACTORY_RE = new RegExp(`function (${ID})\\((${ID}),(${ID})\\)\\{let ${ID}=${ID}\\(${ID},(${ID})=>${ID}\\(\\2\\(\\4\\),\\3\\),\\{getServerSnapshot:\\(\\)=>\\3,onMount\\(`, 'g');
const persistedFactories = (C) => once('persistedFactories', () => {
  const at = [];                                      // renderer chunks with a static-factory match
  for (const f of C.webFiles) { const t = C.text(f); if (t.includes('initialValue:')) { const m = [...t.matchAll(STATIC_FACTORY_RE)]; if (m.length) at.push({ file: f, m }); } }
  const n = at.reduce((a, h) => a + h.m.length, 0);
  if (n !== 1) throw new CensusError(`state.persistedAtoms: static factory shape matched ${n} times${at.length ? ` in ${at.map((h) => stem(h.file)).join(', ')}` : ''}`);
  const km = [...C.text(at[0].file).matchAll(KEYED_FACTORY_RE)];
  if (km.length !== 1) throw new CensusError(`state.persistedAtoms: keyed factory shape matched ${km.length} times in ${stem(at[0].file)}`);
  return { file: at[0].file, staticName: at[0].m[0][1], keyedName: km[0][1], registrar: at[0].m[0][5] };
});

fam['state.persistedAtoms'] = (C) => {
  const { file: f, staticName, keyedName, registrar } = persistedFactories(C);
  // cross-check: the registry call in the static factory is the only way an atom enters the registry (one call site besides the declaration)
  const registrarCalls = [...C.text(f).matchAll(new RegExp(`(?<![\\w$.])${esc(registrar)}\\(`, 'g'))].filter((m) => C.text(f).slice(m.index - 9, m.index) !== 'function ').length;
  const out = new Map(); const unresolved = []; let calls = 0;
  const add = (key, kind, file) => { if (!out.has(key)) out.set(key, { kind, files: new Set() }); out.get(key).files.add(file); };
  const norm = (raw) => raw.includes('${') ? raw.slice(0, raw.indexOf('${')) + '*' : raw;
  for (const [name, kind] of [[staticName, 'static'], [keyedName, 'keyed']]) {
    for (const { file, alias } of aliasesOf(C, f, name)) {
      const s = C.text(file);
      for (const m of s.matchAll(new RegExp(`(?<![\\w$.])${esc(alias)}\\(`, 'g'))) {
        if (s.slice(m.index - 9, m.index) === 'function ') continue;
        const at = m.index + m[0].length - 1; const close = scanBlock(s, at); const a0 = exprEnd(s, at + 1, close);
        const first = s.slice(at + 1, a0).trim(); calls++;
        if (kind === 'static') {
          if (first[0] === '`' && first.includes('${')) { const r = resolveStr(C, file, first); if (r !== null) add(r, 'static', file); else add(norm(first.slice(1, -1)), 'dynamic', file); }
          else { const r = resolveStr(C, file, first); if (r !== null) add(r, 'static', file); else unresolved.push(`${stem(file)}: ${first.slice(0, 40)}`); }
        } else {
          const km2 = /^\(?[\w$]+\)?=>([`"'])([^]*)\1$/.exec(first);       // the key function is an arrow returning a template (or plain string)
          if (km2) add(norm(km2[2]), 'keyed', file); else unresolved.push(`${stem(file)}: ${first.slice(0, 40)}`);
        }
      }
    }
  }
  const pure = out.has('*') ? [...out.get('*').files].map(stem) : [];
  out.delete('*');
  const values = sorted([...out.keys()]);
  const kinds = { static: 0, keyed: 0, dynamic: 0 }; for (const v of out.values()) kinds[v.kind]++;
  const chunks = uniq([...out.values()].flatMap((v) => [...v.files]));
  return {
    anchor: 'static factory `function F(e,t,n){R({initialValue:t,key:e});` and keyed factory `function K(e,t){let n=W(S,n=>V(e(n),t),{getServerSnapshot:()=>t,onMount(`, each located by shape in whichever renderer chunk declares it; key = first arg of every call (alias-chased into lazy chunks; template, quoted string, const identifier or `${const}` template resolved)',
    files: [role(C, f), `renderer:${chunks.length} chunks`], anchorHits: { 'static factory': 1, 'keyed factory': 1 },
    count: values.length, values, kinds, factoryCalls: calls, fullyDynamicKeyCalls: pure.length, unresolvedKeyCalls: unresolved.length, unresolved: unresolved.slice(0, 12),
    crossCheck: { registryCallSites: registrarCalls },
    falsePositiveRisk: `calls whose key is built by a non-constant expression (${unresolved.length}) are listed in unresolved; keys ending in * are prefixes of runtime-built keys; chunks that re-export the factory instead of importing it are not chased`,
  };
};

/** Shared objects: the keyed values the main process owns (`sharedObjectRepository`) and a window reads through the preload bridge
 *  (`electronBridge.getSharedObjectSnapshotValue`) and writes/subscribes through the bus (`shared-object-set|subscribe|unsubscribe`, answered by
 *  `shared-object-updated`). 20770 had 20 keys, 21477 five (remote control), 22943 none: the mechanism is still in the bundle (repository class,
 *  bus cases, preload bridge) but no code reads or writes a key any more (remote control state is an AppHost service now), so the vocabulary is
 *  empty: `retired`. That is only reported when every consumer signal is demonstrably absent; a consumer that is present but not located fails. */
fam['state.sharedObjects'] = (C) => {
  const lit = (name, pre = '', post = '') => new RegExp(`${pre}(["'\`])${name}\\1${post}`);          // a string literal in any quote
  const withText = (files, needle, re) => files.filter((x) => { const t = C.text(x); return t.includes(needle) && (!re || re.test(t)); });
  const roles = (files) => uniq(files.map((x) => role(C, x))).sort();
  // --- the plumbing, each by its own string, so the mechanism's presence is known whoever uses it
  const handlerFiles = withText(C.mainFiles, 'shared-object-set', lit('shared-object-set', 'case', ':'));   // main: the per-window `case shared-object-set:`
  const repoFiles = withText(C.mainFiles, 'sharedObjectRepository');                                       // main: the repository field/option
  const bridgeFiles = withText(C.mainFiles, 'getSharedObjectSnapshotValue');                               // preload: the bridge method
  const atomFiles = withText(C.webFiles, 'getSharedObjectSnapshotValue');                                  // renderer: the atom that reads the bridge
  const busFiles = withText(C.webFiles, 'shared-object-', lit('shared-object-(?:set|subscribe|unsubscribe)'));   // renderer: dispatches of the write/subscribe messages
  const noopFiles = withText(C.webFiles, 'shared-object-updated', lit('shared-object-updated', 'case', ':break'));   // renderer: `case shared-object-updated:break` (ignored)
  if (!handlerFiles.length && !repoFiles.length && !bridgeFiles.length && !atomFiles.length && !busFiles.length)
    throw new CensusError('state.sharedObjects: no shared-object signal in either realm (no bus case, repository, bridge method or renderer atom): removed or renamed; confirm and retire the family');
  if (handlerFiles.length > 1) throw new CensusError(`state.sharedObjects: main \`case shared-object-set:\` matched in ${handlerFiles.length} files`);
  if (!handlerFiles.length && (repoFiles.length || bridgeFiles.length)) throw new CensusError('state.sharedObjects: the repository or bridge is there but the main-process `case shared-object-set:` is not');
  // --- renderer: the atom and its accessors; no atom is only "no consumers" when nothing else in the renderer speaks the messages
  const rendererKeys = new Map(); const unresolved = []; let accessors = 0; let f = null;
  if (atomFiles.length) {
    if (atomFiles.length !== 1) throw new CensusError(`state.sharedObjects: renderer shared-object atom matched in ${atomFiles.length} files`);
    f = atomFiles[0]; const t = C.text(f);
    const am = new RegExp(`(${ID})=${ID}\\(${ID},(${ID})=>window\\.electronBridge\\??\\.getSharedObjectSnapshotValue(?:\\?\\.)?\\(\\2\\),`, 'g');
    const a = [...t.matchAll(am)];
    if (a.length !== 1) throw new CensusError(`state.sharedObjects: renderer shared-object atom matched ${a.length} times`);
    const atom = a[0][1];
    const win0 = Math.max(0, a[0].index - 2500); const win1 = a[0].index + 2500;
    const accs = [];
    for (const m of t.slice(win0, win1).matchAll(new RegExp(`function (${ID})\\(([\\w$,]*)\\)\\{`, 'g'))) {
      const b = win0 + m.index + m[0].length - 1; const e = scanBlock(t, b); if (e < 0) continue;
      const body = t.slice(b, e); const params = m[2].split(',');
      let key = new RegExp(`dispatchMessage\\((["'\`])shared-object-set\\1,\\{key:([\\w$]+)`).exec(body)?.[2];
      key ??= new RegExp(`[(,]${esc(atom)},([\\w$]+)[,)]`).exec(body)?.[1];
      if (key && params.includes(key)) accs.push({ name: m[1], keyIndex: params.indexOf(key) });
    }
    if (accs.length < 3) throw new CensusError(`state.sharedObjects: found only ${accs.length} accessor functions near the atom`);
    accessors = accs.length;
    for (const acc of accs) for (const { file, alias } of aliasesOf(C, f, acc.name)) {
      const s = C.text(file);
      for (const m of s.matchAll(new RegExp(`(?<![\\w$.])${esc(alias)}\\(`, 'g'))) {
        if (s.slice(m.index - 9, m.index) === 'function ') continue;
        const open = m.index + m[0].length - 1; const close = scanBlock(s, open);
        const args = []; let i = open + 1;
        while (i < close) { const e = exprEnd(s, i, close); args.push(s.slice(i, e).trim()); i = e + 1; }
        const raw = args[acc.keyIndex] ?? ''; const v = resolveStr(C, file, raw);
        if (v !== null) { if (!rendererKeys.has(v)) rendererKeys.set(v, new Set()); rendererKeys.get(v).add(stem(file)); } else unresolved.push(`${stem(file)}: ${raw.slice(0, 30)}`);
      }
    }
  } else if (busFiles.length) throw new CensusError(`state.sharedObjects: the renderer dispatches shared-object messages (${roles(busFiles).join(', ')}) but no atom reads the preload bridge`);
  // --- main: the keys given to the repository as literals; a key passed as a variable is counted (the bus handler's `set(t.key,t.value)` is one: a window's own write)
  const mainKeys = new Set(); const keyFiles = new Set(); let mainDynamic = 0;
  for (const x of C.mainFiles) {
    const t = C.text(x); if (!t.includes('sharedObjectRepository')) continue;
    for (const m of t.matchAll(/sharedObjectRepository\??\.(?:get|set)\(/g)) {      // first argument: a string literal in any quote is a key, anything else is dynamic
      const at = m.index + m[0].length; const k = tpl(t.slice(at, exprEnd(t, at, t.length)).trim());
      if (k !== null) { mainKeys.add(k); keyFiles.add(x); } else mainDynamic++;
    }
  }
  const values = sorted(uniq([...rendererKeys.keys(), ...mainKeys]));
  return {
    anchor: 'renderer: accessors declared beside the atom `X=wo(S,e=>window.electronBridge?.getSharedObjectSnapshotValue?.(e),` (set/get/update/hook), key arg of each call, alias-chased; main: `sharedObjectRepository.(get|set)(`key`)` (any quote), in every main-process file; the mechanism itself (bus `case shared-object-set:`, repository, preload bridge, renderer dispatches) is located by its own strings and reported as `plumbing`',
    files: uniq([...(f ? [role(C, f)] : []), ...roles(handlerFiles), ...roles([...keyFiles])]), anchorHits: { 'renderer shared-object atom': atomFiles.length, 'main shared-object-set handler': handlerFiles.length },
    count: values.length, values, retired: values.length === 0 && !atomFiles.length && !busFiles.length,
    parts: { renderer: rendererKeys.size, main: mainKeys.size, accessors, unresolvedKeyCalls: unresolved.length, unresolved: unresolved.slice(0, 8) },
    plumbing: { mainHandler: roles(handlerFiles), mainRepository: roles(repoFiles), preloadBridge: roles(bridgeFiles), rendererAtom: roles(atomFiles), rendererDispatchesMessages: roles(busFiles), rendererIgnoresUpdates: roles(noopFiles), mainDynamicKeyCalls: mainDynamic },
    falsePositiveRisk: 'keys passed as non-constant expressions are listed in unresolved; keys the main process sets through a variable are missed (mainDynamicKeyCalls counts them); `retired` means no consumer signal exists in the renderer, not that the main process cannot still hold objects',
  };
};

// ---- 3. commands, settings, panels, items, apphost, routes ---------------------------------------------------------
fam['commands.ids'] = (C) => {
  const f = commandChunk(C); const t = C.text(f);
  const anchor = '[{id:`newTask`,titleIntlId:';
  C.one([f], anchor, 'command table start');
  // the three tables are assembled as `Z=[...tag(A,`webview`),...tag(B,`vscode-only`),...tag(C,`electron-only`)]`
  const asm = [...t.matchAll(new RegExp(`\\[\\.\\.\\.(${ID})\\((${ID}),\`webview\`\\),\\.\\.\\.\\1\\((${ID}),\`vscode-only\`\\),\\.\\.\\.\\1\\((${ID}),\`electron-only\`\\)\\]`, 'g'))];
  if (asm.length !== 1) throw new CensusError(`commands.ids: command-table assembly [...tag(A,\`webview\`),...tag(B,\`vscode-only\`),...tag(C,\`electron-only\`)] matched ${asm.length} times`);
  const tables = [['webview', asm[0][2]], ['vscode-only', asm[0][3]], ['electron-only', asm[0][4]]];
  const byKind = {}; const ids = []; const unresolved = []; let expanded = 0;
  for (const [kind, name] of tables) {
    const defs = [...t.matchAll(new RegExp(`(?<![\\w$.])${esc(name)}=\\[`, 'g'))];
    if (defs.length !== 1) throw new CensusError(`commands.ids: table ${kind} definition matched ${defs.length} times`);
    const open = defs[0].index + defs[0][0].length - 1;
    if (kind === 'webview' && t.slice(open, open + anchor.length) !== anchor) throw new CensusError('commands.ids: the webview table does not start with the newTask anchor');
    const ae = arrayElements(t, open); byKind[kind] = [];
    for (const el of ae.elements) {
      const text = t.slice(el.start, el.end);
      if (text[0] === '{') {
        const oe = objectEntries(t, el.start); const p = oe.entries.find((e) => e.key === 'id' && e.kind === 'prop');
        const v = p && resolveStr(C, f, t.slice(p.valueStart, p.end));
        if (v) { byKind[kind].push(v); ids.push(v); } else unresolved.push(text.slice(0, 40));
      } else {
        const m = /^\.\.\.\[((?:\d+,?)+)\]\.map\(([\w$]+)=>\(\{id:`([^`$]*)\$\{\2\}`/.exec(text);   // ...[1,2,3].map(e=>({id:`focusTab${e}`,...}))
        if (m) for (const n of m[1].split(',')) { byKind[kind].push(`${m[3]}${n}`); ids.push(`${m[3]}${n}`); expanded++; }
        else unresolved.push(text.slice(0, 40));
      }
    }
  }
  if (ids.length < 100) throw new CensusError(`commands.ids: only ${ids.length} ids`);
  const cross = {};
  for (const h of C.find(C.mainFiles, '{id:`newTask`,titleIntlId:')) { const s2 = C.text(h.file); const arr = enclosingOpen(s2, s2.indexOf('{id:`newTask`,titleIntlId:'), '['); const e2 = arrayElements(s2, arr); cross[stem(h.file)] = e2.elements.length; }
  const values = ids.slice().sort();
  return {
    anchor: 'command-table assembly `[...tag(A,`webview`),...tag(B,`vscode-only`),...tag(C,`electron-only`)]`; A starts `[{id:`newTask`,titleIntlId:`; id = literal, `Enum.member.id`, or `...[1..9].map(e=>({id:`prefix${e}`}))` expansion',
    files: [role(C, f)], anchorHits: { '[{id:`newTask`,titleIntlId:': 1, 'tag(A,webview)..tag(C,electron-only) assembly': 1 },
    count: ids.length, values, duplicates: ids.length - new Set(ids).size, byKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, v.length])), expandedByMap: expanded, unresolvedElements: unresolved.length, unresolved: unresolved.slice(0, 5),
    crossCheck: { mainProcessLibCopiesWebviewTableElements: cross },
    falsePositiveRisk: 'ids of elements built by other computation are listed in unresolved; vscode-only commands exist only for the VS Code host and never reach the Electron app, kept in byKind so a consumer can drop them',
  };
};

fam['settings.slugs'] = (C) => {
  // The table is one array literal of {slug} objects. Which chunk holds it is the bundler's choice (app-initial in 20770/21477, app-primary in
  // 22943), so every renderer chunk is searched and exactly one hit is demanded; the first element and the quote style are matched as written.
  const anchor = '[{slug:`general-settings`},';
  const hit = C.oneRe(C.webFiles, new RegExp(`\\[\\{(?:slug|"slug"|'slug'):${litRe('general-settings')}[,}]`, 'g'), 'settings slug table', 'general-settings');
  const f = hit.file; const t = C.text(f);
  const ae = arrayElements(t, hit.index);
  const slugs = [];
  for (const el of ae.elements) { if (t[el.start] !== '{') continue; const oe = objectEntries(t, el.start); const p = oe.entries.find((e) => e.key === 'slug' && e.kind === 'prop'); const v = p && tpl(t.slice(p.valueStart, p.end)); if (v) slugs.push(v); }
  if (slugs.length < 30) throw new CensusError(`settings.slugs: only ${slugs.length}`);
  return {
    anchor: '`[{slug:`general-settings`},` array in the renderer chunk that holds it (app-initial, app-primary, ...): `slug:` of each element', files: [role(C, f)], anchorHits: { [anchor]: 1 },
    count: slugs.length, values: slugs, duplicates: slugs.length - new Set(slugs).size,
    falsePositiveRisk: 'low; the table generates the /settings/<slug> routes. Order is the sidebar order',
  };
};

/** The tab-kind registry's two registrars, found by what they do (both write one Map keyed by tab kind), not by how a minifier spelled them:
 *  register(kind, Component, options): a 3-parameter function that builds `{...options, <inherited options>, Component, dropDestinations, kind}` and `MAP.set(kind, thatObject)`;
 *  register({kind, ...}): a 1-parameter function that `MAP.set(meta.kind, meta)` (written as `if(...)return` in 21477, as a ternary in 22943).
 *  Every renderer chunk that mentions `dropDestinations:` is a candidate; exactly one register(kind, Component, options) must exist. -> {file, register, meta, map} */
function tabRegistrars(C) {
  const found = [];
  for (const f of C.webFiles) {
    const t = C.text(f); if (!t.includes('dropDestinations:')) continue;
    for (const m of t.matchAll(new RegExp(`function (${ID})\\((${ID}),(${ID}),(${ID})\\)\\{(?:let|const|var) (${ID})=\\{\\.\\.\\.\\4,`, 'g'))) {
      const [, name, kind, comp, opts, obj] = m; const open = m.index + m[0].lastIndexOf('{');
      const oe = objectEntries(t, open); if (!oe) continue;
      const val = (key) => { const e = oe.entries.find((x) => x.key === key && x.kind === 'prop'); return e ? t.slice(e.valueStart, e.end).trim() : null; };
      if (val('Component') !== comp || val('kind') !== kind || val('dropDestinations') === null || !oe.entries.some((x) => x.kind === 'spread' && t.slice(x.valueStart, x.end).trim() === opts)) continue;
      const body = enclosingOpen(t, open); const be = scanBlock(t, body);
      const map = new RegExp(`(?<![\\w$.])(${ID})\\.set\\(${esc(kind)},${esc(obj)}\\)`).exec(t.slice(body, be))?.[1];
      if (map) found.push({ file: f, register: name, map });
    }
  }
  if (found.length !== 1) throw new CensusError(`panel.tabKinds: register(kind, Component, options) shape matched ${found.length} times`);
  const { file, register, map } = found[0]; const t = C.text(file);
  const metas = [];
  for (const m of t.matchAll(new RegExp(`(?<![\\w$.])${esc(map)}\\.set\\((${ID})\\.kind,\\1\\)`, 'g'))) {
    const open = enclosingOpen(t, m.index); const d = open < 0 ? null : new RegExp(`function (${ID})\\(${esc(m[1])}\\)$`).exec(t.slice(Math.max(0, open - 80), open));
    if (d) metas.push(d[1]);
  }
  if (metas.length !== 1) throw new CensusError(`panel.tabKinds: register({kind,...}) metadata shape matched ${metas.length} times`);
  return { file, register, meta: metas[0], map };
}
fam['panel.tabKinds'] = (C) => {
  const { file: f, register, meta } = tabRegistrars(C); const t = C.text(f);
  const found = new Map(); const unresolved = []; let sites = 0;
  const record = (kind, file, expr) => { if (kind == null) { unresolved.push(`${stem(file)}: ${expr.slice(0, 50)}`); return; } if (!found.has(kind)) found.set(kind, new Set()); found.get(kind).add(stem(file)); };
  for (const { file, alias } of aliasesOf(C, f, register)) {
    const s = C.text(file);
    for (const at of callSites(C, file, alias, f)) {
      const open = at + alias.length; const close = scanBlock(s, open); const e = exprEnd(s, open + 1, close);
      const expr = s.slice(open + 1, e); sites++;
      record(resolveStr(C, file, expr), file, expr);
    }
  }
  for (const { file, alias } of aliasesOf(C, f, meta)) {
    const s = C.text(file);
    for (const at of callSites(C, file, alias, f)) {
      const m = /^\(\{\.\.\.([\w$]+),/.exec(s.slice(at + alias.length, at + alias.length + 60)); if (!m) continue;
      sites++; record(resolveStr(C, file, `${m[1]}.kind`), file, `${m[1]}.kind`);
    }
  }
  const values = sorted([...found.keys()]);
  const em = new RegExp(`\\{BROWSER:${litRe('browser')},DIFF:${litRe('diff')},[^}]*\\}`).exec(t);
  const builtin = em ? [...em[0].matchAll(/([A-Z_]+):(?:`([^`]+)`|"([^"]+)"|'([^']+)')/g)].map((x) => x[2] ?? x[3] ?? x[4]) : [];
  return {
    anchor: 'two registrar shapes writing one Map, found by what they do: `register(kind,Component,options)` (builds `{...options,<inherited options>,Component,dropDestinations,kind}` and `MAP.set(kind,it)`) and `register({kind,...})` (`MAP.set(meta.kind,meta)`); first arg of every call (alias-chased; a local of the same name in scope is not a call of the registrar) resolved from template literal, `X.kind`, `Enum.MEMBER` or a const',
    files: [role(C, f), `renderer:${uniq([...found.values()].flatMap((v) => [...v])).length} chunks`], anchorHits: { 'register(kind,Component,options)': 1, 'register({kind})': 1 },
    count: values.length, values, registerCallSites: sites, unresolvedSites: unresolved.length, unresolved: unresolved.slice(0, 10), builtinTabIdEnum: builtin,
    falsePositiveRisk: `tab types whose kind is not statically resolvable (${unresolved.length}) are listed in unresolved; builtinTabIdEnum (browser, diff, plan, ...) is the id enum of fixed side-panel tabs, a different thing from registered kinds`,
  };
};

fam['items.types'] = (C, opts) => {
  const needle = 'case`contextCompaction`:';
  const hits = C.find(C.webFiles, needle);
  if (!hits.length) throw new CensusError('items.types: no switch contains case`contextCompaction`');
  const sw = [];
  for (const h of hits) {
    const t = C.text(h.file); let i = -1;
    while ((i = t.indexOf(needle, i + 1)) >= 0) {
      const open = enclosingOpen(t, i);
      if (open < 0 || !/switch\([\w$.]+\)$/.test(t.slice(open - 24, open).replace(/\s/g, ''))) continue;
      const l = switchLabels(t, open).labels;
      if (l.includes('userMessage') && l.includes('agentMessage') && l.includes('commandExecution')) sw.push({ file: h.file, labels: l });
    }
  }
  if (!sw.length) throw new CensusError('items.types: no switch contains userMessage+agentMessage+commandExecution+contextCompaction');
  const max = Math.max(...sw.map((s) => s.labels.length));
  const union = sw.filter((s) => s.labels.length === max);
  if (union.length !== 1) throw new CensusError(`items.types: ${union.length} switches share the largest label set (${max}); expected exactly 1 renderer turn-item union`);
  const values = sorted(uniq(union[0].labels));
  const proto = opts.schemas.experimental.threadItems ?? [];
  const inProto = values.filter((v) => proto.includes(v));
  return {
    anchor: 'switches in renderer chunks whose labels include userMessage, agentMessage, commandExecution and contextCompaction; the largest one is the renderer turn-item union',
    files: uniq(sw.map((s) => role(C, s.file))), anchorHits: { 'item switches': sw.length, 'largest (union) switch': 1 },
    count: values.length, values, switches: sw.map((s) => ({ file: role(C, s.file), labels: s.labels.length })),
    crossCheck: { schemaThreadItemTypes: proto.length, rendererKnowsOfThem: inProto.length, schemaTypesTheRendererDoesNotSwitchOn: proto.filter((p) => !values.includes(p)), rendererOnlyTypes: values.filter((v) => !proto.includes(v)) },
    falsePositiveRisk: 'the 36-label union mixes protocol ThreadItem types (19) with renderer-synthesised turn items (17: error, steered, todo-list, ...); an item type handled only by `.type===` comparisons and no switch would be missed',
  };
};

fam['apphost.services'] = (C) => {
  const regs = C.find(C.mainFiles, 'registerAppView(');
  if (!regs.length) throw new CensusError('apphost.services: no main file contains registerAppView(');
  const f = regs.map((h) => h.file).find((x) => /createAppHost\((\w+)\)\{/.test(C.text(x)));
  if (!f) throw new CensusError('apphost.services: no main file defines createAppHost(e){');
  const t = C.text(f);
  const defs = [...t.matchAll(/createAppHost\((\w+)\)\{/g)];
  if (defs.length !== 1) throw new CensusError(`apphost.services: method definition createAppHost(e){ matched ${defs.length} times`);
  const b = defs[0].index + defs[0][0].length - 1; const e = scanBlock(t, b); const body = t.slice(b, e);
  // the host is built by the method's own `return new X({...})` (not a nested function's)
  const rets = []; scanBlock(body, 0, (j, c, d) => { if (d === 0 && c === 'r') { const m = /^return new ([\w$.]+)\(\{/.exec(body.slice(j, j + 80)); if (m && !isId(body[j - 1])) rets.push(j + m[0].length - 1); } return false; });
  if (rets.length !== 1) throw new CensusError(`apphost.services: \`return new X({\` matched ${rets.length} times in createAppHost`);
  const oe = objectEntries(body, rets[0]);
  // the host class: `get services(){return this.#p}constructor({a:e,b:t,...r}){super(),this.#p={...r,extra:...}}`; the private field may be any name, the class sits in any main chunk
  const clsRe = /get services\(\)\{return this\.#([\w$]+)\}constructor\(\{([^}]*?)\.\.\.([\w$]+)\}\)\{super\(\),this\.#\1=\{\.\.\.\3,/g;
  const clsHits = C.findRe(C.mainFiles, clsRe, 'get services()');
  if (clsHits.length !== 1 || clsHits[0].count !== 1) throw new CensusError(`apphost.services: host class \`get services(){return this.#p}constructor({k:e,...t}){...this.#p={...t,\` matched ${clsHits.reduce((n, h) => n + h.count, 0)} times in ${clsHits.length} files`);
  const cf = clsHits[0].file; const ct = C.text(cf); const cls = clsHits[0].first;
  const excluded = cls[2].split(',').map((x) => x.split(':')[0].trim()).filter(Boolean);
  const extraEnt = objectEntries(ct, cls.index + cls[0].lastIndexOf('{...'));
  const extra = []; const extraUnread = [];
  for (const x of extraEnt.entries) {
    if (x.key) extra.push(x.key);
    else if (x.kind === 'spread' && ct.slice(x.valueStart, x.end).trim() !== cls[3]) {
      const r = spreadKeys(ct, ct.slice(x.valueStart, x.end));
      if (r.note) extraUnread.push(r.note); else extra.push(...r.keys);
    } else if (x.kind !== 'spread') extraUnread.push(`an entry that is neither a key nor a spread: ${ct.slice(x.start, Math.min(x.end, x.start + 40))}`);
  }
  // the constructor's spreads are read as the host object's are: one that cannot be would silently drop its services (port review 4)
  if (extraUnread.length) throw new CensusError(`apphost.services: ${extraUnread.length} spreads of the host class's services cannot be read (${extraUnread.slice(0, 3).join('; ')})`);
  const keys = []; const conditional = []; const spreadInfo = []; let emptySpreads = 0;
  for (const en of oe.entries) {
    if (en.key) keys.push(en.key);
    else if (en.kind === 'spread') {
      const r = spreadKeys(t, body.slice(en.valueStart, en.end), body);
      if (!r.keys.length && !r.note) { emptySpreads++; continue; }           // `...{}`: a service the build left out (a flag folded to false)
      keys.push(...r.keys); conditional.push(...(r.conditional ?? [])); spreadInfo.push({ keys: r.keys, conditional: r.conditional ?? [], note: r.note });
    }
  }
  const unread = spreadInfo.filter((x) => x.note);                           // a spread whose object cannot be read would silently drop its services: fail instead
  if (unread.length) throw new CensusError(`apphost.services: ${unread.length} spreads of the host object cannot be read (${unread.map((x) => x.note).slice(0, 3).join('; ')})`);
  const values = sorted(uniq([...keys.filter((k) => !excluded.includes(k)), ...extra]));
  return {
    anchor: 'method `createAppHost(e){` -> `return new Host({...})` object literal (+ spreads read by what they evaluate to: `...fn()`, `...(a,{...})`, `...c?{...}:{}`, `...name`, `...a.fn()`; + the host class constructor that drops `getConnection`/`globalState` and adds `browserAuthOperations`)',
    files: uniq([role(C, f), role(C, cf)]), anchorHits: { 'createAppHost(e){': 1, 'return new Host({': 1, 'host class constructor': 1 },
    count: values.length, values, parts: { literalKeys: oe.entries.filter((x) => x.key).length, spreads: spreadInfo, ...(emptySpreads ? { emptySpreads } : {}), excluded, extra },
    conditionalServices: uniq(conditional),
    falsePositiveRisk: 'a listed key may hold void 0/null in a given window (per-window presence is runtime); conditional keys (platform- or appearance-gated) are marked; services added to the host object after construction would be missed',
  };
};

fam['routes.paths'] = (C) => {
  // The route table is one chunk's JSX: <Route path=...> elements, one component dominating the calls that carry a path prop. Which chunk holds it is the bundler's
  // choice (app-initial in 20770/21477, app-runtime in 22943), so every renderer chunk is counted and exactly one may hold >= 50 of them.
  const ROUTE_EL = /\(0,[\w$]+\.jsxs?\)\(([\w$]+),\{(?:index:!0,)?path:/g;
  const tables = [];
  for (const file of C.webFiles) {
    const ft = C.text(file); if (!ft.includes('path:')) continue;
    const cnt = new Map();
    for (const m of ft.matchAll(ROUTE_EL)) cnt.set(m[1], (cnt.get(m[1]) ?? 0) + 1);
    const top = [...cnt].sort((a, b) => b[1] - a[1]);
    if (top.length && top[0][1] >= 50) tables.push({ file, top });
  }
  if (tables.length !== 1) throw new CensusError(`routes.paths: no dominant Route component (${tables.length} chunks with >= 50 Route elements: ${JSON.stringify(tables.map((x) => [basename(x.file), x.top.slice(0, 2)]))})`);
  const { file: f, top } = tables[0]; const t = C.text(f);
  if (top[1] && top[1][1] * 10 > top[0][1]) throw new CensusError(`routes.paths: no dominant Route component (candidates ${JSON.stringify(top.slice(0, 3))})`);
  const R = top[0][0];
  const lits = []; const unresolved = []; let index = 0; let withPath = 0;
  for (const m of t.matchAll(new RegExp(`\\(0,[\\w$]+\\.jsxs?\\)\\(${esc(R)},\\{`, 'g'))) {
    const oe = objectEntries(t, m.index + m[0].length - 1);
    if (!oe) continue;
    const p = oe.entries.find((e) => e.key === 'path' && e.kind === 'prop');
    if (!p) { if (oe.entries.some((e) => e.key === 'index')) index++; continue; }
    withPath++;
    const raw = t.slice(p.valueStart, p.end); const v = resolveStr(C, f, raw);
    if (v !== null) lits.push(v); else unresolved.push(raw.slice(0, 40));
  }
  const nav = new Set();
  const NAV = new RegExp(`type:${litRe('navigate-to-route')},path:(?:\`([^\`$]*)\`|"([^"$]*)"|'([^'$]*)')`, 'g');
  for (const file of [...C.mainFiles, ...C.webFiles]) { const ft = C.text(file); if (!ft.includes('navigate-to-route')) continue; for (const m of ft.matchAll(NAV)) nav.add(m[1] ?? m[2] ?? m[3]); }
  const values = sorted(uniq(lits));
  return {
    anchor: 'JSX Route elements `(0,jsx)(R,{path:...})` in the renderer chunk that holds the route table, R = the dominant component among jsx calls with a path prop; path = template/string literal, const identifier or `${const}` template',
    files: [role(C, f)], anchorHits: { 'Route component': 1 },
    count: values.length, values, routeElementsWithPath: withPath, indexRoutes: index, unresolvedPaths: unresolved.length, unresolved: unresolved.slice(0, 12), routeComponentCandidates: top.slice(0, 3),
    navigateToRouteTargets: sorted([...nav]),
    falsePositiveRisk: 'paths built from member expressions or computed (unresolved) and the slug-generated settings routes (see settings.slugs) are not in values; nested route paths are relative to their parent route',
  };
};

// ---- 4. i18n, data-app-* -------------------------------------------------------------------------------------------
fam['i18n.ids'] = (C, opts) => {
  if (C.localeFiles.length < 20) throw new CensusError(`i18n.ids: only ${C.localeFiles.length} locale catalogs carry ${LOCALE_ANCHOR}`);
  const pivotFile = [...C.localeKeyCount].sort((a, b) => b[1] - a[1])[0][0];
  const t = C.text(pivotFile);
  const d = /([\w$]+) as default/.exec(t.slice(t.lastIndexOf('export{')));
  if (!d) throw new CensusError(`i18n.ids: no default export in ${pivotFile}`);
  const m = new RegExp(`(?<![\\w$.])${esc(d[1])}=\\{`).exec(t);
  const oe = objectEntries(t, m.index + m[0].length - 1);
  const ids = oe.entries.filter((e) => e.kind === 'prop').map((e) => e.key);
  const dup = ids.length - new Set(ids).size;
  const codeIds = new Set(); let codeSites = 0;
  for (const f of C.webFiles) { const s = C.text(f); if (!s.includes('defaultMessage:')) continue; for (const x of s.matchAll(/\bid:`([^`$]+)`,defaultMessage:/g)) { codeIds.add(x[1]); codeSites++; } }
  const idSet = new Set(ids);
  const sorted_ = sorted(ids);
  const counts = [...C.localeKeyCount.values()];
  return {
    anchor: 'locale catalogs = renderer chunks named xx-YY-<hash>.js (>400KB) that carry the key "codex.command.newThread":; ids = keys of the default-export object of the largest catalog',
    files: [`renderer:${C.localeFiles.length} locale catalogs`], anchorHits: { [LOCALE_ANCHOR]: C.localeFiles.length },
    count: ids.length, digestSha256: createHash('sha256').update(sorted_.join('\n')).digest('hex'),
    sample: [0, 1, 2, 3, 4].map((i) => sorted_[Math.floor(i * sorted_.length / 5) + 7]),
    values: opts.fullI18n ? sorted_ : undefined,
    crossCheck: { pivotCatalog: stem(pivotFile), catalogs: C.localeFiles.length, quickKeyCountRangeAcrossCatalogs: [Math.min(...counts), Math.max(...counts)], duplicateKeysInPivot: dup,
      codeDefinedMessages: { uniqueIds: codeIds.size, sites: codeSites, notInCatalog: [...codeIds].filter((x) => !idSet.has(x)).length, catalogNotInCode: ids.filter((x) => !codeIds.has(x)).length } },
    falsePositiveRisk: 'catalog ids mix content-hash ids (6 chars) and named ids; code defines ~20k more (id,defaultMessage) pairs than the catalogs translate, so "message ids" is 32,385 translated or ~51,800 defined depending on the reading (both reported)',
  };
};

fam['dom.dataAppAttrs'] = (C) => {
  const found = new Map();
  for (const f of [...C.mainFiles, ...C.webFiles]) { const t = C.text(f); if (!t.includes('data-app-')) continue; for (const m of t.matchAll(/data-app-[a-z0-9]+(?:-[a-z0-9]+)*(?![\w-])/g)) { if (!found.has(m[0])) found.set(m[0], new Set()); found.get(m[0]).add(role(C, f)); } }
  const cssOnly = [];
  for (const f of C.cssFiles) { const t = C.src.read(f); if (!t.includes('data-app-')) continue; for (const m of t.matchAll(/data-app-[a-z0-9]+(?:-[a-z0-9]+)*(?![\w-])/g)) if (!found.has(m[0]) && !cssOnly.includes(m[0])) cssOnly.push(m[0]); }
  const values = sorted([...found.keys()]);
  if (values.length < 20) throw new CensusError(`dom.dataAppAttrs: only ${values.length}`);
  const prefixes = {}; for (const v of values) { const p = v.split('-').slice(0, 3).join('-'); prefixes[p] = (prefixes[p] ?? 0) + 1; }
  return {
    anchor: 'literal attribute names matching data-app-[a-z0-9-]+ in main-process and renderer JS (css selectors cross-checked)',
    files: [`renderer+main:${uniq([...found.values()].flatMap((s) => [...s])).length} files`], anchorHits: { 'data-app-*': values.length },
    count: values.length, values, byPrefix: prefixes, cssOnly,
    falsePositiveRisk: 'names assembled at runtime (data-app-action-${x}) appear only as a literal prefix, if at all; names that occur only in a CSS selector are listed in cssOnly',
  };
};

// ---- 5. protocol ---------------------------------------------------------------------------------------------------
fam['protocol.schema'] = (C, opts) => {
  const out = {};
  for (const [name, sc] of Object.entries(opts.schemas)) {
    out[name] = Object.fromEntries(CATEGORIES.map((c) => [c, { count: sc.methods[c].length, methods: sorted(sc.methods[c]) }]));
    out[name].total = CATEGORIES.reduce((a, c) => a + sc.methods[c].length, 0);
    const ns = {}; for (const m of sc.methods.ClientRequest) { const k = m.includes('/') ? m.split('/')[0] : '(root)'; ns[k] = (ns[k] ?? 0) + 1; }
    out[name].clientRequestNamespaces = ns;
  }
  const s = opts.schemas.stable; const x = opts.schemas.experimental;
  const diff = {};
  for (const c of CATEGORIES) diff[c] = { experimentalOnly: sorted(x.methods[c].filter((m) => !s.methods[c].includes(m))), stableOnly: sorted(s.methods[c].filter((m) => !x.methods[c].includes(m))) };
  return {
    anchor: 'ClientRequest/ServerRequest/ClientNotification/ServerNotification.json: oneOf[].properties.method.enum[0] (stable and experimental)',
    files: ['schema', 'schema-experimental'], anchorHits: { 'oneOf[].properties.method.enum[0]': out.stable.total + out.experimental.total },
    count: out.experimental.total, values: sorted(CATEGORIES.flatMap((c) => x.methods[c].map((m) => `${c}:${m}`))), perSchema: out, experimentalMinusStable: diff,
    fingerprints: Object.fromEntries(Object.keys(x.fingerprints).sort().map((k) => [k, x.fingerprints[k]])),
    falsePositiveRisk: 'none (generated). Methods only in experimental are gated by the experimentalApi capability',
  };
};

fam['protocol.wireOnly'] = (C, opts) => {
  const known = new Set(); for (const sc of Object.values(opts.schemas)) for (const c of CATEGORIES) for (const m of sc.methods[c]) known.add(m);
  const namespaces = new Set([...known].filter((m) => m.includes('/')).map((m) => m.split('/')[0]));
  // an MCP name (below) is left out on weak evidence only: the app's category table or its own app-server call says it is the app server's
  const SURE = new Set(['categoryTable', 'sendAppServerRequest', 'sendAppServerExtensionRequest']);
  const evidence = new Map(); const add = (name, ev) => { if (known.has(name) || (mcp.has(name) && !SURE.has(ev))) return; if (!evidence.has(name)) evidence.set(name, new Set()); evidence.get(name).add(ev); };
  const METHOD_SHAPE = /^[a-z][A-Za-z0-9]*(?:\/[A-Za-z][A-Za-z0-9]*){0,3}$/;
  // the app's method->category table `{"thread/start":`thread`,...}`: located by its entry wherever the chunk is (app-initial in 20770/21477 and 22943; the command table that names the "app-initial" role moved to app-shared in 22943)
  const entry = qs('thread/start').flatMap((k) => qs('thread').map((v) => `${k}:${v}`));
  const ini = C.one(C.webFiles, entry, 'method->category table entry ("thread/start":`thread`)');
  const it = C.text(ini); const ai = indexOfAny(it, entry);
  const catObj = objectEntries(it, enclosingOpen(it, ai));
  const catMap = {}; for (const e of catObj.entries) if (e.kind === 'prop') { const v = tpl(it.slice(e.valueStart, e.end)); if (v !== null) catMap[e.key] = v; }
  const STRONG = ['sendAppServerRequest', 'sendAppServerExtensionRequest'];
  const WEAK = ['sendRequest', 'createRequest', 'enqueueRequest', 'addNotificationCallback', 'onNotification', 'requestNative'];
  const scope = uniq([...C.mainFiles, ...C.webFiles.filter((f) => /^(app-initial|app-shared|app-primary)-/.test(basename(f))), ini]);
  // every pattern takes a method name in any quote spelling (22943's main process writes "x") and a comparison either way round (`.method==="x"`, `"x"===e.method`)
  const NAME = '[a-z][A-Za-z0-9]*(?:\\/[A-Za-z][A-Za-z0-9]*){1,3}';
  // the MCP SDK ships in both realms and its method names share namespaces with the app server's (`server/discover`, vendored into 22943's
  // main process): a name an MCP method schema declares (`method:z.literal("server/discover")`, the SDK's request and notification shapes)
  // is MCP's unless sure evidence says otherwise
  const mcp = new Set();
  const MCP_SCHEMA = new RegExp(`method:[\\w$]+\\.literal\\((["'\`])(${NAME})\\1\\)`, 'g');
  for (const f of scope) for (const x of C.text(f).matchAll(MCP_SCHEMA)) mcp.add(x[2]);
  for (const k of Object.keys(catMap)) { if (k.includes('/')) namespaces.add(k.split('/')[0]); add(k, 'categoryTable'); }
  const callRe = new RegExp(`\\b(${[...STRONG, ...WEAK].join('|')})\\((["'\`])([^"'\`$]+)\\2`, 'g');
  const weak = new Map();
  const inNs = (n) => n.includes('/') && namespaces.has(n.split('/')[0]);
  for (const f of scope) {
    const t = C.text(f);
    for (const m of t.matchAll(callRe)) {
      const name = m[3]; if (!METHOD_SHAPE.test(name)) continue;
      if (STRONG.includes(m[1]) || inNs(name)) add(name, m[1]);
      else if (!known.has(name)) { if (!weak.has(name)) weak.set(name, new Set()); weak.get(name).add(`${m[1]}@${stem(f)}`); }
    }
    for (const m of t.matchAll(/methods:\[((?:["'`][^"'`]+["'`],?)+)\]/g)) for (const x of m[1].matchAll(/["'`]([^"'`]+)["'`]/g)) if (METHOD_SHAPE.test(x[1]) && inNs(x[1])) add(x[1], 'methods[]');
    for (const m of t.matchAll(new RegExp(`(?:case|\\.method===|method:)(["'\`])(${NAME})\\1|(["'\`])(${NAME})\\3===[\\w$]+\\.method`, 'g'))) { const n = m[2] ?? m[4]; if (inNs(n)) add(n, 'case/compare/method:'); }
    // wire-method rewriting inside a `switch(e.method)`: `let o=e.method;switch(e.method){case`thread/start`:...o=`thread/prewarm`}`
    for (const m of t.matchAll(new RegExp(`(?<![\\w$.])[\\w$]+=(["'\`])(${NAME})\\1[,;)}]`, 'g'))) if (inNs(m[2]) && /\bswitch\([\w$]+\.method\)|\.method\b/.test(t.slice(Math.max(0, m.index - 600), m.index))) add(m[2], 'method-rewrite assignment');
    // arrays/sets of method names that also hold a schema method: `new Set([`account/login/start`,`account/sessions/add`])`
    for (const m of t.matchAll(new RegExp(`\\[((?:(["'\`])${NAME}\\2,?){2,})\\]`, 'g'))) { const names = [...m[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1]); if (names.some((n) => known.has(n))) for (const n of names) if (inNs(n)) add(n, 'array-with-schema-methods'); }
  }
  const bare = new Map();
  for (const f of [ini, ...C.mainFiles.filter((x) => /^src-/.test(basename(x)) || x === mainFile(C))]) {
    // a bare literal is a string used as a value: the object keys that are quoted (`,"environment/create":zodSchema`, `"model/obj":{…}` MIME tables) are not
    for (const m of C.text(f).matchAll(new RegExp(`([{,]?)(["'\`])(${NAME})\\2(:?)`, 'g'))) { if (m[1] && m[4]) continue; const n = m[3]; if (known.has(n) || evidence.has(n) || !namespaces.has(n.split('/')[0])) continue; if (!bare.has(n)) bare.set(n, new Set()); bare.get(n).add(stem(f)); }
  }
  const values = sorted([...evidence.keys()].filter((n) => !known.has(n)));
  const detail = Object.fromEntries(values.map((n) => [n, sorted([...evidence.get(n)])]));
  const byCat = {}; for (const v of Object.values(catMap)) byCat[v] = (byCat[v] ?? 0) + 1;
  return {
    anchor: 'literal method names in neither schema, with call-shape evidence: app method->category table (`"thread/start":`thread``), first arg of sendAppServerRequest/sendAppServerExtensionRequest (any shape) and of sendRequest/addNotificationCallback/... (schema namespace only), `methods:[..]` lists, `case`/`.method===` labels (either way round), arrays that also hold a schema method, `x=`ns/name`` assignments next to a `.method` switch (wire-method rewriting); any quote spelling, main-process code in whatever chunks',
    files: [role(C, ini), 'main-process:main + shared libs'], anchorHits: { 'method->category table': 1 },
    count: values.length, values, evidence: detail,
    weakCandidates: Object.fromEntries([...bare].map(([k, v]) => [k, sorted([...v])])),
    weakCalleeOnly: Object.fromEntries([...weak].map(([k, v]) => [k, sorted([...v])])),
    mcpMethodNames: sorted([...mcp].filter((n) => inNs(n) && !known.has(n))),
    categoryTable: { methods: Object.keys(catMap).length, categories: Object.keys(byCat).length, byCategory: byCat, notInEitherSchema: Object.keys(catMap).filter((k) => !known.has(k)).length },
    falsePositiveRisk: 'method-shaped strings of other protocols (MCP tools/call, LSP workspace/applyEdit, browser environment/*) share namespaces; only call-shape evidence is counted, bare literals go to weakCandidates. Names built by concatenation are missed. None has a parameter schema',
  };
};

// ---- 6. choke points -----------------------------------------------------------------------------------------------
// the anchors are the ones the build-time seams are derived from (seams.mjs): the census and the derivers can never disagree about a site
const countRe = (C, files, needle, re) => files.filter((f) => C.text(f).includes(needle)).map((f) => ({ f, n: (C.text(f).match(re) ?? []).length })).filter((x) => x.n);
fam['choke.jsx'] = (C) => {
  const r = countRe(C, C.webFiles, '.jsxs=', JSX_RE); const m = countRe(C, C.mainFiles, '.jsxs=', JSX_RE);
  const tot = r.reduce((a, x) => a + x.n, 0);
  if (tot !== 1) throw new CensusError(`choke.jsx: factory shape X.Fragment=F,X.jsx=G,X.jsxs=G} matched ${tot} times in renderer chunks (expected 1)`);
  return { anchor: '`X.Fragment=F,X.jsx=G,X.jsxs=G}` (jsx and jsxs are the same function)', files: [role(C, r[0].f)], anchorHits: { jsxFactory: 1 }, count: 1, values: [stem(r[0].f)],
    otherCopies: m.map((x) => `${role(C, x.f)}x${x.n}`), falsePositiveRisk: 'a second JSX factory ships inside the in-app browser page-preload bundle (main-process directory); it is a different realm and is not the app renderer' };
};
fam['choke.lazy'] = (C) => {
  const r = countRe(C, C.webFiles, 'Promise.resolve();if(', LAZY_RE);
  const tot = r.reduce((a, x) => a + x.n, 0);
  if (tot !== 1) throw new CensusError(`choke.lazy: Vite preload helper shape matched ${tot} times in renderer chunks (expected 1)`);
  const guard = (C.text(r[0].f).match(new RegExp(LAZY_GUARD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;
  if (guard !== 1) throw new CensusError(`choke.lazy: the helper's chunk holds ${guard} \`${LAZY_GUARD}\` events (expected 1)`);
  return { anchor: '`N=function(a,b,c){let r=Promise.resolve();if(b&&b.length>0){let a=document.getElementsByTagName(`link`)` (Vite preload helper)', files: [role(C, r[0].f)], anchorHits: { vitePreloadHelper: 1 }, count: 1, values: [stem(r[0].f)], falsePositiveRisk: 'none seen; the helper is vendor code and its shape tracks Vite' };
};
fam['choke.react'] = (C) => {
  const sh = appShared(C); const st = C.text(sh);
  const react = {};
  for (const [what, anchor] of [['react', 'e.useSyncExternalStore=function'], ['react-dom', 'e.createPortal=function'], ['react-dom-client', 'e.createRoot=function']]) {
    const n = (st.match(new RegExp(esc(anchor), 'g')) ?? []).length;
    if (n !== 1) throw new CensusError(`choke.react: ${anchor} matched ${n} times in app-shared (expected 1)`);
    const i = st.indexOf(anchor); const v = /\.version=`(\d+\.\d+\.\d+[^`]*)`/.exec(st.slice(i, i + 60000));
    react[what] = v?.[1] ?? null;
  }
  if (!react.react || !react['react-dom']) throw new CensusError('choke.react: version string not found after the React anchors');
  return { anchor: '`.version=` template following `e.useSyncExternalStore=function` (react) and `e.createPortal=function` (react-dom) in the app-shared chunk', files: [role(C, sh)], anchorHits: { 'e.useSyncExternalStore=function': 1, 'e.createPortal=function': 1, 'e.createRoot=function': 1 },
    count: 1, values: [react.react], versions: react, falsePositiveRisk: 'low; React ships as a CJS wrapper inside app-shared, so version strings are exact. A second React in another chunk would not be seen' };
};

fam['choke.taps'] = (C) => {
  const sites = [['commands', 'command descriptor table `X=[{id:`newTask`,`', '[{id:`newTask`,', TAP_TABLE_RE, C.webFiles],
    ['handlers', 'command handler table `X=new Map([[`newTask`,`', 'new Map([[`newTask`,', TAP_HANDLERS_RE, C.webFiles],
    ['messages', 'command message table `X={...Y,"codex.command.importExternalAgent":`', '"codex.command.importExternalAgent":', TAP_MESSAGES_RE, C.webFiles]];
  const found = {}; const files = [];
  for (const [name, what, needle, re, scope] of sites) {
    const r = countRe(C, scope, needle, re); const tot = r.reduce((a, x) => a + x.n, 0);
    if (tot !== 1) throw new CensusError(`choke.taps: the ${what} matched ${tot} times in renderer chunks (expected 1)`);
    found[name] = role(C, r[0].f); files.push(found[name]);
  }
  return { anchor: 'the three command sites a tap prepends to: the descriptor array (`X=[{id:`newTask`,`), the default-handler Map (`X=new Map([[`newTask`,`) and the message catalog (`X={...Y,"codex.command.importExternalAgent":`)',
    files: uniq(files), anchorHits: { commands: 1, handlers: 1, messages: 1 }, count: 3, values: Object.entries(found).map(([k, v]) => `${k}@${v}`),
    falsePositiveRisk: 'low; the strings are command ids. The locale catalogs hold the message id as data and are not matched by the `X={...Y,` form' };
};
fam['choke.menus'] = (C) => {
  const r = countRe(C, C.webFiles, MENU_NEEDLE, MENU_RE); const tot = r.reduce((a, x) => a + x.n, 0);
  if (tot !== 1) throw new CensusError(`choke.menus: the thread menu item builder (\`async function F({scope,target,actions,…,showForkInSidebar,…})\`) matched ${tot} times in renderer chunks (expected 1)`);
  return { anchor: 'the item builder of a thread\'s menus, `async function F({scope:S,target:T,actions:A,…,showForkInSidebar:…})` (the sidebar row\'s and the thread header\'s menus)', files: [role(C, r[0].f)], anchorHits: { menus: 1 }, count: 1, values: [`menus@${role(C, r[0].f)}`],
    falsePositiveRisk: 'low; the parameter names are the app\'s own, and the one other `showForkInSidebar:` is the call site, not a definition' };
};
fam['choke.appHost'] = (C) => {
  // 21477 binds the host (`H=C?.createAppHost(…),V=make(port,H)`); 22943 passes it inline (`V=make(port,C?.createAppHost(…))`)
  const r = [...countRe(C, C.mainFiles, 'registerAppView(', APP_HOST_RE), ...countRe(C, C.mainFiles, 'registerAppView(', APP_HOST_INLINE_RE)]; const tot = r.reduce((a, x) => a + x.n, 0);
  if (tot !== 1) throw new CensusError(`choke.appHost: AppHost creation and AppView registration (\`H=C?.createAppHost(e.sender),V=make(port,H);C?.registerAppView(e.sender,V)\`) matched ${tot} times in the main-process bundles (expected 1)`);
  return { anchor: '`H=C?.createAppHost(e.sender),V=make(port,H);C?.registerAppView(e.sender,V)` in the main-process bundle (the AppHost of each window)', files: [role(C, r[0].f)], anchorHits: { appHost: 1 }, count: 1, values: [stem(r[0].f)],
    falsePositiveRisk: 'none seen; both method names occur only here and in their definitions' };
};
/** The source the seam derivers read, over the census corpus: asar paths (`.vite/build/...`, `webview/assets/...`) whichever form the input has. */
const seamSource = (C) => {
  const dotted = C.mainFiles[0]?.startsWith('.vite/');
  const real = (p) => (!dotted && p.startsWith('.vite/') ? `vite/${p.slice(6)}` : p);
  const all = C.src.list().map((p) => (!dotted && p.startsWith('vite/') ? `.${p}` : p));
  return { list: (prefix) => all.filter((p) => p.startsWith(prefix)), read: (p) => C.src.read(real(p)), size: (p) => C.src.size(real(p)) };
};
fam['ui.exposures'] = (C) => {
  const ex = deriveExposures(corpusOf(seamSource(C)));
  if (!ex.exposures.length) throw new CensusError(`ui.exposures: none of the ${EXPOSURES.length} exposures of the app's own objects could be located exactly once`);
  const values = ex.exposures.map((e) => `${e.key}@${e.role}`).sort();
  return { anchor: `${EXPOSURES.length} objects of the app, each located by strings and structure and found exactly once in the renderer chunks (adapters/tools/seams.mjs EXPOSURES; a dry run of the derivers)`,
    files: uniq(ex.exposures.map((e) => `renderer:${e.role}`)), anchorHits: Object.fromEntries(ex.exposures.map((e) => [e.key, 1])), count: values.length, values,
    missing: Object.fromEntries(ex.missing.map((m) => [m.item.replace(/^expose:/, ''), m.tried])),
    falsePositiveRisk: 'an exposure whose anchor still matches once but whose object changed meaning is caught by the binding that uses it (canary), not here' };
};
fam['lazy.addresses'] = (C) => {
  const re = /\(\)=>\{let\{([\w$:,\s]+)\}=await import\(`\.\/([\w.-]+?)-[0-9a-f]{12}\.js`\);return\{([\w$:,\s]+)\}\}/g;
  const pairs = new Set(); let sites = 0;
  for (const f of C.webFiles) {
    const t = C.text(f);
    if (!t.includes('await import(`./')) continue;
    for (const m of t.matchAll(re)) { sites++; for (const e of m[3].split(',')) { const name = e.split(':')[0].trim(); if (name) pairs.add(`${m[2]}:${name}`); } }
  }
  if (!pairs.size) throw new CensusError('lazy.addresses: no lazily loaded named export `()=>{let{X:e}=await import(`./chunk-<hash>.js`);return{X:e}}` found in the renderer chunks');
  return { anchor: 'static (chunk, export) pairs of the lazy importers `()=>{let{X:e}=await import(`./chunk-<hash>.js`);return{X:e}}`: what the lazy seam hands to a binding (the chunk is its name without the content hash)',
    files: ['renderer:*'], anchorHits: { importers: sites }, count: pairs.size, values: sorted([...pairs]),
    falsePositiveRisk: 'pairs only; importers that load a whole module or build the export list dynamically are not addresses' };
};

/** The static binding census (docs/design/systems.md S17): for each binding of the framework's addresses (framework/renderer/present/
 *  addresses.json), the app's JSX call sites whose props carry its keys (`exact`: those keys and no spread), and where there are none,
 *  the object literals that carry them (a spread's source, weaker). A binding found by neither is not missing: the feature log reads it
 *  as unknown. Bindings addressed by an exposure are the ui.exposures family's. */
const JSX_CALL = /\bjsxs?\)\(([\w$.]+),\{/g;
fam['bindings.sites'] = (C, opts) => {
  const bindings = (opts.addresses?.bindings ?? []).filter((b) => Array.isArray(b.keys) && b.keys.length);
  if (!bindings.length) throw new CensusError('bindings.sites: no binding addressed by prop keys (framework/renderer/present/addresses.json)');
  const keyed = (ents) => new Set(ents.filter((e) => e.kind === 'prop' || e.kind === 'shorthand' || e.kind === 'method').map((e) => e.key));
  // `optional` (with `exact`): keys a build's call may also carry; any other key is another component's
  const fits = (b, ents) => { const k = keyed(ents); if (!b.keys.every((x) => k.has(x))) return false; return !b.exact || ([...k].every((x) => b.keys.includes(x) || b.optional?.includes(x)) && !ents.some((e) => e.kind === 'spread' || e.kind === 'unknown')); };
  const sites = Object.fromEntries(bindings.map((b) => [b.id, { jsx: 0, objects: 0 }]));
  let calls = 0;
  for (const f of C.webFiles) {
    const t = C.text(f);
    if (!t.includes('jsx')) continue;
    for (const m of t.matchAll(JSX_CALL)) {
      const o = objectEntries(t, m.index + m[0].length - 1);
      if (!o) continue;
      calls++;
      for (const b of bindings) if (fits(b, o.entries)) sites[b.id].jsx++;
    }
  }
  if (!calls) throw new CensusError('bindings.sites: no JSX call site `jsx)(Component,{...})` found in the renderer chunks');
  // A binding with no JSX site: the object literals that carry its keys (props built apart, then spread into the element).
  for (const b of bindings) {
    if (sites[b.id].jsx || b.exact) continue;
    const needle = `${b.keys[0]}:`;
    for (const f of C.webFiles) {
      const t = C.text(f);
      for (let i = t.indexOf(needle); i >= 0; i = t.indexOf(needle, i + needle.length)) {
        if (isId(t[i - 1])) continue;
        const open = enclosingOpen(t, i, '{', 20_000);
        if (open < 0) continue;
        const o = objectEntries(t, open);
        if (o && fits(b, o.entries)) sites[b.id].objects++;
      }
    }
  }
  const found = bindings.filter((b) => sites[b.id].jsx || sites[b.id].objects).map((b) => b.id);
  const addressesSha256 = addressesDigest(opts.addresses);
  return { anchor: 'the JSX call sites `jsx)(X,{...})` of the renderer chunks, each binding\'s prop keys among their props (addresses.json); else object literals carrying them',
    files: ['renderer:*'], anchorHits: { jsxCalls: calls }, count: found.length, values: sorted(found), sites, addressesSha256,
    notFound: sorted(bindings.filter((b) => !found.includes(b.id)).map((b) => b.id)),
    falsePositiveRisk: 'a key set is evidence that the address exists, not of the component\'s identity (a one-key exact address matches many sites); the canary checks identity at run time' };
};

// =====================================================================================================================
// 5. Driver
// =====================================================================================================================
const ORDER = ['bus.fromView', 'bus.toView', 'bus.fetchHandlers', 'ipc.channels', 'state.globalKeys', 'state.persistedAtoms', 'state.sharedObjects',
  'commands.ids', 'settings.slugs', 'panel.tabKinds', 'items.types', 'apphost.services', 'routes.paths', 'i18n.ids', 'dom.dataAppAttrs',
  'protocol.schema', 'protocol.wireOnly', 'choke.jsx', 'choke.lazy', 'choke.react', 'choke.taps', 'choke.menus', 'choke.appHost', 'ui.exposures', 'lazy.addresses',
  'bindings.sites'];
const ADDRESSES = new URL('../../framework/renderer/present/addresses.json', import.meta.url);

/**
 * Run the census. `input` is an app.asar file, its extraction, or a source object {list(), read(path), size(path)} (tests wrap one); the schema directories are the build's stable and experimental bundles.
 * Returns {census, build, files, families, summary, runtimeMs}; a family that cannot anchor exactly is {status: "fail", error} and emits no values.
 */
export function census(input, schemaDir, schemaExperimentalDir, { only = [], fullI18n = false, addresses = null } = {}) {
  const t0 = performance.now();
  // The locator and alias caches belong to one input: a second census in the same process (another build, or the same code with a drifted anchor) must not see the first one's files.
  memo.clear(); exportAliasCache.clear(); importCache.clear();
  const src = typeof input === 'object' ? input : statSync(input).isDirectory() ? new DirSource(input) : new AsarSource(input);
  const C = new Corpus(src);
  const schemas = { stable: readSchema(schemaDir), experimental: readSchema(schemaExperimentalDir) };
  const opts = { schemas, fullI18n, addresses: addresses ?? (existsSync(ADDRESSES) ? JSON.parse(readFileSync(ADDRESSES, 'utf8')) : null) };
  const out = { census: 1, build: { name: C.pkg.name, version: C.pkg.version, buildNumber: C.pkg.codexBuildNumber ?? null }, files: { main: C.mainFiles.length, renderer: C.webFiles.length, localeCatalogs: C.localeFiles.length }, families: {} };
  let failed = 0;
  for (const id of ORDER) {
    if (only.length && !only.some((o) => id.startsWith(o))) continue;
    const s = performance.now();
    try { const r = fam[id](C, opts); if (Array.isArray(r.values) && r.digestSha256 === undefined) r.digestSha256 = createHash('sha256').update(r.values.join('\n')).digest('hex'); out.families[id] = { status: 'ok', ...r, ms: Math.round(performance.now() - s) }; }
    catch (e) { failed++; out.families[id] = { status: 'fail', error: e instanceof CensusError ? e.message : `${e.name}: ${e.message}`, ms: Math.round(performance.now() - s) }; if (!(e instanceof CensusError)) out.families[id].stack = String(e.stack).split('\n').slice(0, 4); }
  }
  out.summary = { families: Object.keys(out.families).length, failed, counts: Object.fromEntries(Object.entries(out.families).map(([k, v]) => [k, v.status === 'ok' ? v.count : 'FAIL'])) };
  out.runtimeMs = Math.round(performance.now() - t0);
  return out;
}

function main(argv) {
  const args = argv.slice(2); const flags = new Set(args.filter((a) => a.startsWith('--') && !a.includes('=')));
  const only = (args.find((a) => a.startsWith('--only='))?.slice(7) ?? '').split(',').filter(Boolean);
  const pos = args.filter((a) => !a.startsWith('--'));
  if (pos.length !== 3) { console.error('usage: census.mjs <extracted-asar-dir | app.asar> <schemaDir> <schemaExperimentalDir> [--only=a,b] [--full-i18n] [--compact]'); process.exit(64); }
  const out = census(pos[0], pos[1], pos[2], { only, fullI18n: flags.has('--full-i18n') });
  process.stdout.write(JSON.stringify(out, null, flags.has('--compact') ? 0 : 1) + '\n');
  process.exitCode = out.summary.failed ? 2 : 0;          // not process.exit(): a piped stdout may still be flushing
}
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/census.mjs')) main(process.argv);
