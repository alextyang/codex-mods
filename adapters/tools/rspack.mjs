// The renderer of an rspack build (25679 on: the webview is no longer Vite/rolldown output). Every chunk is an ES module that exports its module
// factories, `export const __rspack_esm_ids=[<chunk>];export const __webpack_modules__={<id>(e,t,i){…},…}`, and the runtime chunk holds its own in
// `var …,u={<id>(e,a,c){…},…}`. A name the app declares is local to its module's factory, so a seam or an exposure is found, and written, inside one
// module. rspack copies a module into every chunk that needs it and minifies each copy on its own (the same module id, other local names), so one
// site is one module id, edited in each of its copies.
import { matchClose } from './scan.mjs';

/** True for a chunk of an rspack renderer (a module-map chunk, or the runtime chunk that installs the others). */
export const isRspackChunk = (text) => /^(?:\/\*![^]*?\*\/\s*)?export const __rspack_esm_ids=/.test(text.slice(0, 400)) || text.includes('__rspack_esm_runtime');

const HEAD = /^(?:([A-Za-z0-9_$]+)|"([^"\\]+)")\(([\w$,]*)\)\{/;
/**
 * The module factories of an rspack chunk in source order: `{ id, params, start, open, close }` (`start` at the id, `open` at the body's `{`, `close` at its
 * `}`); null for a chunk that is not one. The map is read entry by entry with the regex-aware bracket matcher; an entry it cannot read ends the list.
 */
export function rspackModules(text) {
  if (!isRspackChunk(text)) return null;
  let i;
  const named = text.indexOf('export const __webpack_modules__={');
  if (named >= 0) i = named + 'export const __webpack_modules__={'.length;
  else {
    // the runtime chunk: `var e,a,…,u={Gav4(e,a,c){…`, the first object literal of its leading declaration
    const m = /^var (?:[A-Za-z_$][\w$]*,)*([A-Za-z_$][\w$]*)=\{/.exec(text);
    if (!m) return [];
    i = m[0].length;
  }
  const out = [];
  for (;;) {
    const h = HEAD.exec(text.slice(i, i + 160));
    if (!h) break;
    const open = i + h[0].length - 1;
    const close = matchClose(text, open);
    if (close < 0) break;
    out.push({ id: h[1] ?? h[2], params: h[3], start: i, open, close });
    i = close + 1;
    if (text[i] !== ',') break;
    i++;
  }
  return out;
}

/** The module (of `rspackModules`) whose body holds `index`, or null. */
export function moduleAt(modules, index) {
  let lo = 0; let hi = modules.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1; const m = modules[mid];
    if (index <= m.open) hi = mid - 1;
    else if (index >= m.close) lo = mid + 1;
    else return m;
  }
  return null;
}

/** The text a module's head is written with (`<id>(<params>){`, the id quoted when it is not a bare name): unique in its chunk, where an edit inside the module is anchored. */
export const moduleHead = (text, m) => text.slice(m.start, m.open + 1);
