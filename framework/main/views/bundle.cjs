'use strict';
// Bundles the renderer runtime's ES-module graph into ONE classic script for webFrame.executeJavaScript.
// Why: the app page's CSP (script-src 'self') blocks importing framework files by URL, while code injected by the preload is not
// subject to it. No build step and no dependencies: this is a deliberately small linker for the ESM subset the framework's renderer
// code uses, and it fails loudly (naming file and line) on anything else.
//
// Supported, at the start of a line:
//   import def, { a, b as c } from './x.mjs';   import * as ns from '../y.mjs';   import './side-effect.mjs';
//   export function f / export async function f / export class C / export const|let|var x = …
//   export { a, b as c };   export { a } from './z.mjs';   export * from './z.mjs';   export default <expression>;
// Not supported (throws): bare specifiers, import.meta, top-level await, destructuring exports, import cycles.
// Dynamic import(...) is left untouched.
const fs = require('node:fs');
const path = require('node:path');

const IDENT = '[A-Za-z_$][\\w$]*';
const RE = {
  importFrom: new RegExp(`^import\\s+(?:(${IDENT})\\s*,?\\s*)?(?:\\{([^}]*)\\}|\\*\\s+as\\s+(${IDENT}))?\\s*from\\s*['"]([^'"]+)['"];?[ \\t]*$`, 'gm'),
  importBare: /^import\s+['"]([^'"]+)['"];?[ \t]*$/gm,
  exportDecl: new RegExp(`^export\\s+((?:async\\s+)?function\\*?|class|const|let|var)\\s+(${IDENT})`, 'gm'),
  exportList: /^export\s*\{([^}]*)\}\s*(?:from\s*['"]([^'"]+)['"])?;?[ \t]*$/gm,
  exportStar: /^export\s+\*\s+from\s*['"]([^'"]+)['"];?[ \t]*$/gm,
  exportDefault: /^export\s+default\s+/gm,
};

function lineOf(src, index) { return src.slice(0, index).split('\n').length; }

function parseList(list, file, src, index) {
  return list.split(',').map((s) => s.trim()).filter(Boolean).map((part) => {
    const m = new RegExp(`^(${IDENT})(?:\\s+as\\s+(${IDENT}))?$`).exec(part);
    if (!m) throw new Error(`${file}:${lineOf(src, index)}: unsupported specifier "${part}"`);
    return { imported: m[1], local: m[2] ?? m[1] };
  });
}

function resolveSpec(spec, fromFile, file, src, index) {
  if (!spec.startsWith('./') && !spec.startsWith('../')) throw new Error(`${file}:${lineOf(src, index)}: only relative imports are supported, got "${spec}"`);
  return path.resolve(path.dirname(fromFile), spec);
}

/** Transform one module's source. Returns { code, deps: absolute paths, exportNames }. */
function transformModule(src, absFile, baseDir, readModuleId) {
  const rel = path.relative(baseDir, absFile).split(path.sep).join('/');
  if (/\bimport\.meta\b/.test(src)) throw new Error(`${rel}: import.meta is not supported`);
  const deps = [];
  const exportsOut = [];       // { name, expr }   expr = how to read the value inside the module function
  const edits = [];            // { start, end, text }
  const dep = (spec, index) => { const abs = resolveSpec(spec, absFile, rel, src, index); deps.push(abs); return JSON.stringify(readModuleId(abs)); };
  const claim = (re, fn) => { re.lastIndex = 0; for (let m; (m = re.exec(src));) fn(m); };

  claim(RE.importFrom, (m) => {
    const [all, def, named, ns, spec] = m;
    const id = dep(spec, m.index);
    const lines = [];
    if (ns) lines.push(`const ${ns} = __require(${id});`);
    if (def || named) {
      const parts = [];
      if (def) parts.push(`default: ${def}`);
      for (const { imported, local } of named ? parseList(named, rel, src, m.index) : []) parts.push(imported === local ? imported : `${imported}: ${local}`);
      lines.push(`const { ${parts.join(', ')} } = __require(${id});`);
    }
    edits.push({ start: m.index, end: m.index + all.length, text: lines.join(' ') });
  });
  claim(RE.importBare, (m) => { edits.push({ start: m.index, end: m.index + m[0].length, text: `__require(${dep(m[1], m.index)});` }); });
  claim(RE.exportDecl, (m) => {
    exportsOut.push({ name: m[2], expr: m[2] });
    edits.push({ start: m.index, end: m.index + m[0].indexOf(m[1]), text: '' });      // drop only the "export " prefix
  });
  claim(RE.exportList, (m) => {
    const [all, list, spec] = m;
    const items = parseList(list, rel, src, m.index);
    if (spec) {
      const id = dep(spec, m.index);
      const tmp = `__re${exportsOut.length}`;
      for (const { imported, local } of items) exportsOut.push({ name: local, expr: `${tmp}.${imported}`, pre: `const ${tmp} = __require(${id});`, tmp });
      edits.push({ start: m.index, end: m.index + all.length, text: '' });
    } else {
      for (const { imported, local } of items) exportsOut.push({ name: local, expr: imported });
      edits.push({ start: m.index, end: m.index + all.length, text: '' });
    }
  });
  claim(RE.exportStar, (m) => { exportsOut.push({ star: dep(m[1], m.index) }); edits.push({ start: m.index, end: m.index + m[0].length, text: '' }); });
  claim(RE.exportDefault, (m) => {
    const after = src.slice(m.index + m[0].length);
    const named = new RegExp(`^(?:async\\s+)?(?:function\\*?|class)\\s+(${IDENT})`).exec(after);
    if (named) { exportsOut.push({ name: 'default', expr: named[1] }); edits.push({ start: m.index, end: m.index + m[0].length, text: '' }); }
    else { exportsOut.push({ name: 'default', expr: '__default' }); edits.push({ start: m.index, end: m.index + m[0].length, text: 'const __default = ' }); }
  });

  edits.sort((a, b) => b.start - a.start);
  let code = src;
  for (const e of edits) code = code.slice(0, e.start) + e.text + code.slice(e.end);

  if (/^(?:await\s)/m.test(code)) throw new Error(`${rel}: top-level await is not supported`);
  const leftover = /^(?:export|import)\b(?!\s*\()|[;}]\s*(?:export|import)\s+[\w{*'"]/m.exec(code);
  if (leftover) throw new Error(`${rel}:${lineOf(code, leftover.index)}: unsupported module syntax: ${code.slice(leftover.index, leftover.index + 60).split('\n')[0]}`);
  const pre = exportsOut.filter((e) => e.pre).map((e) => e.pre);
  const getters = [];
  for (const e of exportsOut) {
    if (e.star) getters.push(`for (const __k of Object.keys(__require(${e.star}))) if (__k !== 'default') Object.defineProperty(__exports, __k, { enumerable: true, get: () => __require(${e.star})[__k] });`);
    else getters.push(`Object.defineProperty(__exports, ${JSON.stringify(e.name)}, { enumerable: true, get: () => ${e.expr} });`);
  }
  return { rel, code: `${[...new Set(pre)].join('\n')}\n${getters.join('\n')}\n${code}`, deps };
}

/**
 * @param {{ entry: string, baseDir: string, readFile?: (p: string) => string }} opts  entry is an absolute path; baseDir is the root module ids are relative to.
 * @returns {string} a JavaScript EXPRESSION that evaluates to the entry module's exports object.
 */
function bundle({ entry, baseDir, readFile = (p) => fs.readFileSync(p, 'utf8') }) {
  const order = [];                          // absolute paths in dependency order
  const state = new Map();                   // abs → 'visiting' | 'done'
  const outputs = new Map();
  const idOf = (abs) => path.relative(baseDir, abs).split(path.sep).join('/');
  function visit(abs, via) {
    if (state.get(abs) === 'done') return;
    if (state.get(abs) === 'visiting') throw new Error(`import cycle through ${idOf(abs)}${via ? ` (from ${via})` : ''}`);
    state.set(abs, 'visiting');
    const t = transformModule(readFile(abs), abs, baseDir, idOf);
    outputs.set(abs, t);
    for (const d of t.deps) visit(d, t.rel);
    state.set(abs, 'done');
    order.push(abs);
  }
  visit(path.resolve(entry), null);
  const defs = order.map((abs) => {
    const t = outputs.get(abs);
    return `__define(${JSON.stringify(t.rel)}, function (__exports) {\n'use strict';\n${t.code}\n});`;
  });
  return [
    '(function () {',
    "'use strict';",
    'const __defs = Object.create(null), __cache = Object.create(null);',
    'function __define(id, fn) { __defs[id] = fn; }',
    'function __require(id) { let m = __cache[id]; if (m) return m; if (!__defs[id]) throw new Error("module not bundled: " + id); m = __cache[id] = Object.create(null); __defs[id](m); return m; }',
    ...defs,
    `return __require(${JSON.stringify(idOf(path.resolve(entry)))});`,
    '})()',
  ].join('\n');
}

module.exports = { bundle, transformModule };
