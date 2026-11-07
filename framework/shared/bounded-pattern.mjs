// A mod's pattern, matched in time linear in the text (docs/design/mod-surfaces.md §3.3; review 4, round 2). A part renderer's `match` runs
// on the model's text while a message renders, so no pattern may backtrack: refusing the known shapes of catastrophic backtracking left
// others (`(a+){20}`, `(a|a)(a|a)...`), so the framework does not use the engine's backtracking matcher for them at all. A pattern is
// compiled to an automaton (Thompson's construction) and tested by following every state at once: time at most the text's length times
// the automaton's size, whatever the pattern. The JavaScript syntax, less what needs backtracking: alternation, groups (capturing, `(?:`,
// named), the quantifiers (greedy or lazy, the same for a test), `.`, character classes and escapes, `^`, `$`, `\b`, `\B`; flags i, m,
// s, u. Refused: lookarounds, back-references, `\p{...}`. Only whether the pattern occurs is answered (a test), never where.
// Node built-ins only; no imports, so both realms and the page use it.

/** The largest automaton a pattern may make (a counted repeat copies its atom): a pattern's cost is bounded by its text's length times this. */
export const MAX_STATES = 2000;
const LINE_END = (c) => c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;
const DIGIT = (c) => c >= 0x30 && c <= 0x39;
const WORD = (c) => DIGIT(c) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;
const SPACE = (c) => (c >= 0x09 && c <= 0x0d) || c === 0x20 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029
  || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
const CLASS_ESCAPES = { d: DIGIT, D: (c) => !DIGIT(c), w: WORD, W: (c) => !WORD(c), s: SPACE, S: (c) => !SPACE(c) };
const CONTROL = { t: 0x09, n: 0x0a, v: 0x0b, f: 0x0c, r: 0x0d };

class Refused extends Error {}
const refuse = (why) => { throw new Refused(why); };

/** The pattern's text as units: code points with the u flag, code units without (as the engine reads it). */
const unitsOf = (s, unicode) => (unicode ? Array.from(s, (c) => c.codePointAt(0)) : Array.from({ length: s.length }, (_, i) => s.charCodeAt(i)));

function parse(src, unicode) {
  const u = unitsOf(src, unicode);
  let i = 0;
  const peek = (k = 0) => u[i + k];
  const is = (ch, k = 0) => u[i + k] === ch.codePointAt(0);
  const eat = (ch) => { if (!is(ch)) return false; i++; return true; };
  const hex = (n) => {
    let v = 0;
    for (let k = 0; k < n; k++) {
      const c = peek();
      const d = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1;
      if (d < 0) return null;
      v = v * 16 + d; i++;
    }
    return v;
  };
  const number = () => { let v = null; while (DIGIT(peek() ?? -1)) { v = (v ?? 0) * 10 + (peek() - 0x30); i++; if (v > 1000) refuse('a repeat counts to at most 1000'); } return v; };
  /** An escape after `\`: a code point, or a predicate (`\d`, ...); in a class `\b` is a backspace. */
  function escape(inClass) {
    const c = peek();
    if (c === undefined) refuse('a pattern ends with \\');
    const ch = String.fromCodePoint(c);
    i++;
    if (CLASS_ESCAPES[ch]) return { pred: CLASS_ESCAPES[ch] };
    if (CONTROL[ch] !== undefined) return { cp: CONTROL[ch] };
    if (ch === 'b' && inClass) return { cp: 0x08 };
    if (ch === '0' && !DIGIT(peek() ?? -1)) return { cp: 0 };
    if (DIGIT(c) || ch === 'k') refuse('no back-reference');
    if (ch === 'p' || ch === 'P') refuse('no \\p{...}');
    if (ch === 'x') { const v = hex(2); if (v === null) refuse('\\x takes two hex digits'); return { cp: v }; }
    if (ch === 'u') {
      if (unicode && eat('{')) { const at = i; let v = 0; while (!is('}')) { const d = hex(1); if (d === null) refuse('\\u{...} takes hex digits'); v = v * 16 + d; if (v > 0x10ffff) refuse('not a code point'); } if (i === at) refuse('\\u{} is empty'); i++; return { cp: v }; }
      const v = hex(4); if (v === null) refuse('\\u takes four hex digits'); return { cp: v };
    }
    if (ch === 'c') { const l = peek(); if (l !== undefined && ((l >= 0x41 && l <= 0x5a) || (l >= 0x61 && l <= 0x7a))) { i++; return { cp: l % 32 }; } refuse('\\c takes a letter'); }
    return { cp: c };   // an identity escape: the character itself
  }
  function charClass() {
    const negate = eat('^');
    const ranges = [], preds = [];
    const atom = () => (is('\\') ? (i++, escape(true)) : { cp: u[i++] });
    while (!is(']')) {
      if (peek() === undefined) refuse('a class is not closed');
      const a = atom();
      if (is('-') && !is(']', 1) && peek(1) !== undefined) {
        i++;
        const b = atom();
        if (a.pred || b.pred) refuse('a range is between two characters');
        if (a.cp > b.cp) refuse('a range is out of order');
        ranges.push([a.cp, b.cp]);
      } else if (a.pred) preds.push(a.pred);
      else ranges.push([a.cp, a.cp]);
    }
    i++;
    return { t: 'class', negate, ranges, preds };
  }
  function quantifier() {
    let min, max;
    if (eat('*')) { min = 0; max = Infinity; }
    else if (eat('+')) { min = 1; max = Infinity; }
    else if (eat('?')) { min = 0; max = 1; }
    else if (is('{')) {
      const at = i; i++;
      const lo = number();
      let hi = lo;
      if (lo !== null && eat(',')) hi = number() ?? Infinity;
      if (lo === null || !eat('}')) { if (unicode) refuse('a { that is not a repeat'); i = at; return null; }   // a literal {, without u
      if (hi < lo) refuse('a repeat is out of order');
      min = lo; max = hi;
    } else return null;
    eat('?');   // lazy: the same for whether it occurs
    return { min, max };
  }
  function term() {
    if (eat('^')) return { t: 'assert', k: '^' };
    if (eat('$')) return { t: 'assert', k: '$' };
    if (is('\\') && (is('b', 1) || is('B', 1))) { const k = String.fromCodePoint(u[i + 1]); i += 2; return { t: 'assert', k }; }
    let atom;
    if (eat('.')) atom = { t: 'dot' };
    else if (eat('(')) {
      if (eat('?')) {
        if (eat(':')) { /* a group */ }
        else if (is('<') && !is('=', 1) && !is('!', 1)) { i++; while (!is('>')) { if (peek() === undefined) refuse('a group name is not closed'); i++; } i++; }
        else refuse('no lookaround');
      }
      const inner = disjunction();
      if (!eat(')')) refuse('a group is not closed');
      atom = inner;
    } else if (eat('[')) atom = charClass();
    else if (eat('\\')) { const e = escape(false); atom = e.pred ? { t: 'class', negate: false, ranges: [], preds: [e.pred] } : { t: 'char', cp: e.cp }; }
    else {
      const c = peek();
      if (c === 0x2a || c === 0x2b || c === 0x3f) refuse('nothing to repeat');
      if (c === 0x7b && unicode) refuse('nothing to repeat');
      if ((c === 0x7d || c === 0x5d) && unicode) refuse('a lone } or ]');
      i++;
      atom = { t: 'char', cp: c };
    }
    const q = quantifier();
    return q ? { t: 'rep', atom, ...q } : atom;
  }
  function alternative() {
    const items = [];
    while (peek() !== undefined && !is('|') && !is(')')) {
      const t = term();
      if (t.t === 'assert' && (peek() === 0x2a || peek() === 0x2b || peek() === 0x3f)) refuse('an assertion is not repeated');
      items.push(t);
    }
    return { t: 'seq', items };
  }
  function disjunction() {
    const alts = [alternative()];
    while (eat('|')) alts.push(alternative());
    return alts.length === 1 ? alts[0] : { t: 'alt', alts };
  }
  const tree = disjunction();
  if (i < u.length) refuse(is(')') ? 'a ) with no group' : 'the pattern does not parse');
  return tree;
}

function build(tree, flags) {
  const ignoreCase = flags.includes('i'), multiline = flags.includes('m'), dotAll = flags.includes('s');
  const states = [];
  const add = (s) => { if (states.length >= MAX_STATES) refuse(`a pattern makes at most ${MAX_STATES} states (a counted repeat copies what it repeats)`); states.push(s); return states.length - 1; };
  const fold = (pred) => (ignoreCase ? (c) => {
    if (pred(c)) return true;
    const s = String.fromCodePoint(c);
    const lo = s.toLowerCase(), up = s.toUpperCase();
    return (lo.length === s.length && pred(lo.codePointAt(0))) || (up.length === s.length && pred(up.codePointAt(0)));
  } : pred);
  const predOf = (n) => {
    if (n.t === 'char') return fold((c) => c === n.cp);
    if (n.t === 'dot') return dotAll ? () => true : (c) => !LINE_END(c);
    const inSet = (c) => n.ranges.some(([a, b]) => c >= a && c <= b) || n.preds.some((p) => p(c));
    const f = fold(inSet);
    return n.negate ? (c) => !f(c) : f;
  };
  /** The automaton of `n`, followed by state `next`: its first state. */
  function emit(n, next) {
    switch (n.t) {
      case 'char': case 'dot': case 'class': return add({ t: 'step', m: predOf(n), next });
      case 'assert': return add({ t: 'assert', k: n.k, next });
      case 'seq': { let s = next; for (let k = n.items.length - 1; k >= 0; k--) s = emit(n.items[k], s); return s; }
      case 'alt': { let s = emit(n.alts[n.alts.length - 1], next); for (let k = n.alts.length - 2; k >= 0; k--) { const a = emit(n.alts[k], next); s = add({ t: 'split', a, b: s }); } return s; }
      case 'rep': {
        let s;
        if (n.max === Infinity) { const loop = add({ t: 'split', a: -1, b: next }); states[loop].a = emit(n.atom, loop); s = loop; }
        else { s = next; for (let k = 0; k < n.max - n.min; k++) { const a = emit(n.atom, s); s = add({ t: 'split', a, b: next }); } }
        for (let k = 0; k < n.min; k++) s = emit(n.atom, s);
        return s;
      }
      default: return refuse('the pattern does not parse');
    }
  }
  const accept = add({ t: 'match' });
  const start = emit(tree, accept);
  return { states, start, multiline };
}

/**
 * Compile a pattern (`{source, flags}`, flags among i, m, s, u) for a linear-time test, and a linear-time search for where it matches
 * (`find`: the leftmost match from `from`, the longest there, as string offsets; an empty match is none; `budget` `{left}`, shared by a
 * caller's searches, is spent by each position read: once spent, `out` is set and the search finds none). Throws with the reason a
 * pattern is refused (the engine's syntax first: a pattern JavaScript does not take is not taken).
 * @returns {{ test(text: string): boolean, find(text: string, from?: number, budget?: { left: number, out?: boolean }): { start: number, end: number } | null }}
 */
export function compilePattern(source, flags = '') {
  if (typeof source !== 'string' || typeof flags !== 'string' || !/^[imsu]{0,4}$/.test(flags) || new Set(flags).size !== flags.length) throw new Error('a pattern is a source and flags among i, m, s, u');
  new RegExp(source, flags);   // JavaScript's syntax: it throws on what it does not take
  const unicode = flags.includes('u');
  let auto;
  try { auto = build(parse(source, unicode), flags); } catch (e) { if (e instanceof Refused) throw new Error(e.message, { cause: e }); throw e; }
  const { states, start, multiline } = auto;
  const n = states.length;
  let prepared = null;   // the last text `find` searched, prepared
  return Object.freeze({
    test(text) {
      const t = unitsOf(String(text), unicode);
      const len = t.length;
      const cur = new Int32Array(n), next = new Int32Array(n);
      let curN = 0;
      const mark = new Int32Array(n).fill(-1);
      let gen = 0;
      const word = (k) => k >= 0 && k < len && WORD(t[k]);
      // the states reached from s without reading, at position `at`, into list (once each per position)
      const stack = new Int32Array(n);
      const close = (s0, at, list, count) => {
        let sp = 0;
        stack[sp++] = s0;
        while (sp) {
          const s = stack[--sp];
          if (mark[s] === gen) continue;
          mark[s] = gen;
          const st = states[s];
          if (st.t === 'split') { stack[sp++] = st.b; stack[sp++] = st.a; }
          else if (st.t === 'assert') {
            const ok = st.k === '^' ? at === 0 || (multiline && LINE_END(t[at - 1]))
              : st.k === '$' ? at === len || (multiline && LINE_END(t[at]))
                : (word(at - 1) !== word(at)) === (st.k === 'b');
            if (ok) stack[sp++] = st.next;
          } else list[count++] = s;
        }
        return count;
      };
      for (let at = 0; at <= len; at++) {
        gen++;
        // the states this position was reached in, then a match starting here (a test finds it anywhere)
        let c = 0;
        for (let k = 0; k < curN; k++) c = close(cur[k], at, next, c);
        c = close(start, at, next, c);
        for (let k = 0; k < c; k++) if (states[next[k]].t === 'match') return true;
        if (at === len) break;
        // read one: the steps that take it
        curN = 0;
        for (let k = 0; k < c; k++) { const st = states[next[k]]; if (st.t === 'step' && st.m(t[at])) cur[curN++] = st.next; }
      }
      return false;
    },
    find(text, from = 0, budget = null) {
      const str = String(text);
      // the text prepared once for every search of it in turn (its units, each unit's offset in the string): searching a text from one
      // match to the next costs its length once, not once a match (built review H7u)
      if (!prepared || prepared.str !== str) {
        const units = unitsOf(str, unicode);
        const offsets = new Int32Array(units.length + 1);
        for (let k = 0, o = 0; k <= units.length; k++) { offsets[k] = o; if (k < units.length) o += unicode && units[k] > 0xffff ? 2 : 1; }
        prepared = { str, t: units, offs: offsets };
      }
      const { t, offs } = prepared;
      const len = t.length;
      // the first unit at or after `from` (offsets ascend)
      let lo = 0, hi = len;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (offs[mid] < from) lo = mid + 1; else hi = mid; }
      const first = lo;
      const word = (k) => k >= 0 && k < len && WORD(t[k]);
      // each thread carries where its match started; the oldest start reaches a state first (it is added first), so a state keeps it
      const cur = new Int32Array(n), curFrom = new Int32Array(n), next = new Int32Array(n), nextFrom = new Int32Array(n);
      let curN = 0;
      const mark = new Int32Array(n).fill(-1);
      let gen = 0;
      const stack = new Int32Array(n);
      const close = (s0, at, origin, count) => {
        let sp = 0;
        stack[sp++] = s0;
        while (sp) {
          const s = stack[--sp];
          if (mark[s] === gen) continue;
          mark[s] = gen;
          const st = states[s];
          if (st.t === 'split') { stack[sp++] = st.b; stack[sp++] = st.a; }
          else if (st.t === 'assert') {
            const ok = st.k === '^' ? at === 0 || (multiline && LINE_END(t[at - 1]))
              : st.k === '$' ? at === len || (multiline && LINE_END(t[at]))
                : (word(at - 1) !== word(at)) === (st.k === 'b');
            if (ok) stack[sp++] = st.next;
          } else { next[count] = s; nextFrom[count] = origin; count++; }
        }
        return count;
      };
      let best = null;   // [start, end] in units: the leftmost start, then the longest end
      for (let at = first; at <= len; at++) {
        // a caller's budget of positions read, shared by its searches (`{left}`): spent, the search ends with none (`out` says so)
        if (budget && --budget.left < 0) { budget.out = true; return null; }
        gen++;
        let c = 0;
        for (let k = 0; k < curN; k++) if (best === null || curFrom[k] <= best[0]) c = close(cur[k], at, curFrom[k], c);
        if (best === null) c = close(start, at, at, c);   // a match starting here, while none started earlier
        for (let k = 0; k < c; k++) {
          if (states[next[k]].t !== 'match' || at === nextFrom[k]) continue;   // an empty match is none
          if (best === null || nextFrom[k] < best[0] || (nextFrom[k] === best[0] && at > best[1])) best = [nextFrom[k], at];
        }
        if (at === len) break;
        curN = 0;
        for (let k = 0; k < c; k++) {
          const st = states[next[k]];
          if (st.t === 'step' && (best === null || nextFrom[k] <= best[0]) && st.m(t[at])) { cur[curN] = st.next; curFrom[curN] = nextFrom[k]; curN++; }
        }
        if (best !== null && curN === 0) break;
      }
      return best ? { start: offs[best[0]], end: offs[best[1]] } : null;
    },
  });
}
