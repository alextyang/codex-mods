// A small structural scanner for minified JavaScript (Node built-ins only): bracket matching that skips strings, template literals (with their
// `${}` holes), comments and regular-expression literals. Regex literals matter: a class such as `[^\s<>)"'`]` in a bundle would otherwise open a
// string and desynchronise every match after it. The heuristic for "is this `/` a regex" is the usual one (what precedes it). Used by the UI seam
// derivers (seams.mjs); the census keeps its own copy of the same technique.
const isId = (c) => c !== undefined && /[\w$]/.test(c);
const ID = '[A-Za-z_$][\\w$]*';

function skipString(s, i) { const q = s[i]; i++; while (i < s.length) { const c = s[i]; if (c === '\\') { i += 2; continue; } if (c === q) return i + 1; i++; } return i; }
function skipTemplate(s, i) {
  i++;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') return i + 1;
    if (c === '$' && s[i + 1] === '{') { const e = matchClose(s, i + 1); i = e < 0 ? s.length : e + 1; continue; }
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

/** Index of the bracket that closes the `(`, `[` or `{` at `open`; -1 when it never closes. */
export function matchClose(s, open) {
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
    if (c === '(' || c === '[' || c === '{') { depth++; i++; continue; }
    if (c === ')' || c === ']' || c === '}') { if (depth === 0) return i; depth--; i++; continue; }
    i++;
  }
  return -1;
}

/** The top-level function declaration `function NAME(` whose body spans idx: `{ name, start, end }` (end = the closing brace), or null. */
export function enclosingFunction(s, idx) {
  let from = idx;
  for (let tries = 0; tries < 80; tries++) {
    const p = s.lastIndexOf('function ', from);
    if (p < 0) return null;
    from = p - 1;
    const m = new RegExp(`^function (${ID})\\(`).exec(s.slice(p, p + 80));
    if (!m || !/[;}\n)]|^$/.test(s[p - 1] ?? '')) continue;
    const paren = p + m[0].length - 1;
    const pc = matchClose(s, paren);
    if (pc < 0) continue;
    const b = s.indexOf('{', pc);
    const e = b < 0 ? -1 : matchClose(s, b);
    if (e > idx) return { name: m[1], start: p, end: e };
  }
  return null;
}
