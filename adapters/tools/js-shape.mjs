// The shape of a minified bundle, for derivers that locate an edit by what the code means rather than how a minifier spelled it
// (docs/design/layouts.md's port note; the 22943 port). Builds differ in spelling only: a string is a template literal or a quoted one,
// a constant is named or inlined, the path module is `X.default`, `X()`, `(0,X.join)` or plain `X`. A deriver asks for the meaning (a call
// of `join` whose arguments are this string and that constant; a function that returns such a call) and gets back nodes with exact source
// ranges; it still writes its edits as exact text (`find` / `text`), so the pack format and the builder do not change. Tooling only (never
// shipped in the copy): it parses with acorn.
import * as acorn from 'acorn';

const SCOPE_FUNCS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const SKIP = new Set(['type', 'start', 'end', 'loc', 'range']);   // every other key may hold a child node (a value is one when it has a type)

/** Parse a bundle (a script first, a module when that fails); null when neither parses. */
export function parse(text) {
  const base = { ecmaVersion: 'latest', allowHashBang: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowImportExportEverywhere: true };
  for (const sourceType of ['script', 'module']) {
    try { return acorn.parse(text, { ...base, sourceType }); } catch { /* the other kind */ }
  }
  return null;
}

/**
 * The shape of one file: its nodes in source order with their parents and scopes, and the queries the derivers use.
 * @param {string} text
 */
export function shapeOf(text) {
  const ast = parse(text);
  if (!ast) return null;
  const nodes = [];          // every node, in walk (source) order
  const parent = new Map();  // node -> parent node
  const scopeOf = new Map(); // node -> the scope it is in
  const program = { up: null, names: new Map() };
  const scopes = [program];

  /** Where a declaration's name lives: `var` and functions in the nearest function scope, `let`/`const`/`class` in the nearest block. */
  const declare = (scope, name, init, kind) => {
    let s = scope;
    if (kind === 'var') while (s.up && !s.fn) s = s.up;
    if (!s.names.has(name)) s.names.set(name, init ?? null); else s.names.set(name, undefined);   // declared twice in one scope: ambiguous
  };
  const patternIds = (p, out = []) => {
    if (!p) return out;
    if (p.type === 'Identifier') out.push(p);
    else if (p.type === 'ObjectPattern') for (const q of p.properties) patternIds(q.type === 'RestElement' ? q.argument : q.value, out);
    else if (p.type === 'ArrayPattern') for (const q of p.elements) patternIds(q, out);
    else if (p.type === 'RestElement') patternIds(p.argument, out);
    else if (p.type === 'AssignmentPattern') patternIds(p.left, out);
    return out;
  };
  const patternNames = (p, out = []) => {
    if (!p) return out;
    if (p.type === 'Identifier') out.push(p.name);
    else if (p.type === 'ObjectPattern') for (const q of p.properties) patternNames(q.type === 'RestElement' ? q.argument : q.value, out);
    else if (p.type === 'ArrayPattern') for (const q of p.elements) patternNames(q, out);
    else if (p.type === 'RestElement') patternNames(p.argument, out);
    else if (p.type === 'AssignmentPattern') patternNames(p.left, out);
    return out;
  };

  // an explicit stack: a 5 MB bundle is too deep for recursion
  const stack = [{ node: ast, up: null, scope: program }];
  while (stack.length) {
    const { node, up, scope } = stack.pop();
    nodes.push(node);
    if (up) parent.set(node, up);
    scopeOf.set(node, scope);
    let inner = scope;
    if (SCOPE_FUNCS.has(node.type)) {
      if (node.type === 'FunctionDeclaration' && node.id) declare(scope, node.id.name, node, 'var');
      inner = { up: scope, names: new Map(), fn: true };
      scopes.push(inner);
      if (node.type === 'FunctionExpression' && node.id) inner.names.set(node.id.name, node);
      for (const p of node.params) for (const n of patternNames(p)) inner.names.set(n, null);
    } else if (node.type === 'BlockStatement' || node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement'
      || node.type === 'SwitchStatement' || node.type === 'CatchClause' || node.type === 'StaticBlock') {
      inner = { up: scope, names: new Map() };
      scopes.push(inner);
      if (node.type === 'CatchClause') for (const n of patternNames(node.param)) inner.names.set(n, null);
    }
    if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) {
        const names = patternNames(d.id);
        for (const n of names) declare(scope, n, d.id.type === 'Identifier' ? d.init : null, node.kind);
      }
    } else if (node.type === 'ClassDeclaration' && node.id) declare(scope, node.id.name, node, 'let');
    // children, pushed in reverse so they come off the stack in source order
    const kids = [];
    for (const key of Object.keys(node)) {
      if (SKIP.has(key)) continue;
      const v = node[key];
      if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') kids.push(c); } else if (v && typeof v.type === 'string') kids.push(v);
    }
    kids.sort((a, b) => a.start - b.start);
    // a function's own params and body are inside its scope; its name (a declaration) is not
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i], up: node, scope: inner });
  }

  /** The scope that declares the name an identifier uses, or null (a global). */
  const declaringScope = (id) => { for (let s = scopeOf.get(id); s; s = s.up) if (s.names.has(id.name)) return s; return null; };
  // What each declared name is assigned after its declaration (`let d; d="x"`): the right sides of its plain `=` assignments, and
  // `AMBIGUOUS` for any other write (`+=`, a destructuring, `++`), so a name written more than one way is not followed.
  const AMBIGUOUS = Symbol('ambiguous');
  const assigned = new Map();   // scope -> Map<name, node[]>
  const note = (id, value) => {
    const sc = declaringScope(id);
    if (!sc) return;
    let m = assigned.get(sc); if (!m) assigned.set(sc, (m = new Map()));
    const l = m.get(id.name) ?? []; l.push(value); m.set(id.name, l);
  };
  for (const n of nodes) {
    if (n.type === 'AssignmentExpression') {
      if (n.left.type === 'Identifier') note(n.left, n.operator === '=' ? n.right : AMBIGUOUS);
      else if (n.left.type !== 'MemberExpression') for (const id of patternIds(n.left)) note(id, AMBIGUOUS);
    } else if (n.type === 'UpdateExpression' && n.argument.type === 'Identifier') note(n.argument, AMBIGUOUS);
  }

  /**
   * The node an identifier names, in its scope chain at the place it is used: `{ init, assigns }` (null init: a parameter, a pattern or a
   * declaration without a value; `assigns`: the right sides of its later `=` assignments, `null` among them for a write of another kind),
   * or null.
   */
  function binding(id) {
    if (!id || id.type !== 'Identifier') return null;
    const sc = declaringScope(id);
    if (!sc) return null;
    const init = sc.names.get(id.name);
    if (init === undefined) return null;
    return { init, assigns: (assigned.get(sc)?.get(id.name) ?? []).map((v) => (v === AMBIGUOUS ? null : v)) };
  }
  /** The one value a name holds: its initializer when it is never assigned, else its one assignment when it has no initializer; null when
   *  it holds none or more than one (a reassigned name is not followed). */
  function valueOf(id) {
    const b = binding(id);
    if (!b) return null;
    if (b.assigns.length === 0) return b.init;
    return b.init === null && b.assigns.length === 1 ? b.assigns[0] : null;
  }
  /** A string the node is: a string literal, a template literal without expressions, or a name bound to one (followed once). */
  function str(node, depth = 0) {
    if (!node) return null;
    if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked ?? null;
    if (node.type === 'Identifier' && depth < 2) { const v = valueOf(node); return v ? str(v, depth + 1) : null; }
    return null;
  }
  /** The member a call calls: `X.join(`, `X.default.join(`, `X().join(`, `(0,X.join)(` all call `join`; null for anything else. */
  function calleeMember(call) {
    let c = call.callee;
    if (c.type === 'SequenceExpression' && c.expressions.length === 2 && c.expressions[0].type === 'Literal') c = c.expressions[1];
    if (c.type !== 'MemberExpression' || c.computed || c.property.type !== 'Identifier') return null;
    return c.property.name;
  }
  const src = (node) => text.slice(node.start, node.end);
  const count = (needle) => { let n = 0; for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) n++; return n; };

  return {
    text, ast, nodes, parent: (n) => parent.get(n) ?? null, binding, valueOf, str, src, count, calleeMember,
    /** Every node of a type (or types), in source order. */
    all(type) { const types = Array.isArray(type) ? new Set(type) : new Set([type]); return nodes.filter((n) => types.has(n.type)); },
    /** Calls of a member by name (`join`, `spawn`), whatever the object's spelling. */
    calls(name) { return nodes.filter((n) => n.type === 'CallExpression' && calleeMember(n) === name); },
    /** Every place a string value is written as a literal (quoted or template). */
    literals(value) { return nodes.filter((n) => (n.type === 'Literal' && n.value === value) || (n.type === 'TemplateLiteral' && n.expressions.length === 0 && n.quasis[0].value.cooked === value)); },
    /** The function a node is in (the nearest), or null. */
    enclosingFunction(node) { for (let p = parent.get(node); p; p = parent.get(p)) if (SCOPE_FUNCS.has(p.type)) return p; return null; },
    /**
     * The shortest source text around a node that occurs exactly once in the file: the node's own text, else widened to its ancestors'
     * (statement by statement) until unique; null when even its function is not unique.
     */
    unique(node) {
      for (let n = node; n; n = parent.get(n)) {
        const t = src(n);
        if (t.length > 0 && count(t) === 1) return { find: t, node: n };
        if (SCOPE_FUNCS.has(n.type) && n !== node) break;
      }
      return null;
    },
  };
}

/** The files of a source (a `source` of stock.mjs / derive.mjs) with their shapes, parsed once each; files that do not parse are left out. */
export function shapesOf(source, files) {
  const out = [];
  for (const file of files) { const s = shapeOf(source.read(file)); if (s) out.push({ file, shape: s }); }
  return out;
}
