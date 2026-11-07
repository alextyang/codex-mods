// the copy must not expose or hide the Computer Use / browser skills in the plugin cache it shares with the stock app (decision N1, 2026-10-21).
//
// Right after the plugin `.mcp.json` rewrite, upstream's managed tool sync calls one function that, for each installed bundled CUA plugin, copies
// `skills/computer-use`, `skills/control-chrome` or `skills/control-in-app-browser` from the app's own bundled plugin into
// <CODEX_HOME>/plugins/cache/openai-bundled/<plugin>/<version>/ (through a temp dir `.codex-plugin/skill-<uuid>`), or removes it there, depending on this
// app's `cuaReplSurfaces`; it throws `Bundled CUA skill version mismatch` when the bundled plugin version differs from the installed one. A daily copy
// shares that cache with the stock app, so copy and stock would alternately add and remove the skills. The copy's threads see whatever the stock app
// (or the plugin install) left there: the price of never flapping the stock app's state. QA copies get the edit too (their codex-home is their own).
//
// Edit (mandatory, hash-checked, fail closed; minified names are captured from the bundle, never assumed):
//  - `cua-skills-no-expose`  the function returns before it reads, copies, removes or renames anything (`return;` first; its body stays as dead code, so the
//                           checker below stays anchored). Its callers discard its result (checked).
import vm from 'node:vm';
import { applyOp, findMainBundle } from './transform.mjs';

const ID = '[A-Za-z_$][\\w$]*';
const esc = (s) => s.replaceAll('$', '\\$');
const Q = '[`"\']';   // a string literal's quote: 21477 writes template literals, 22943 quoted strings
const quoted = (s) => new RegExp(`${Q}${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${Q}`);
export const SKILLS_ID = 'cua-skills-no-expose';
export const MISMATCH = 'Bundled CUA skill version mismatch';
export const SKILL_NAMES = Object.freeze(['computer-use', 'control-chrome', 'control-in-app-browser']);
/** The filesystem writes of the stock function: what must be unreachable after the edit. */
const WRITES = ['.cp)(', '.rm)(', '.mkdir)(', '.rename)('];

/**
 * Index just past the bracket that closes the one at `open` (`{` or `(`), skipping string and template literals (with nested `${…}`). -1 when unbalanced.
 * Regex literals are not understood; a wrong match is caught by the `vm.Script` parse of the result (fail closed).
 */
export function matchClose(text, open) {
  const stack = [];
  // template text from j: the index of its closing backtick (template done) or of the `{` of a `${` (an expression opens); -1 when unterminated
  const template = (j) => {
    for (; j < text.length; j++) {
      if (text[j] === '\\') { j++; continue; }
      if (text[j] === '`') return j;
      if (text[j] === '$' && text[j + 1] === '{') { stack.push('${'); return j + 1; }
    }
    return -1;
  };
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") { for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++; continue; }
    if (c === '`') { i = template(i + 1); if (i < 0) return -1; continue; }
    if (c === '{' || c === '(' || c === '[') { stack.push(c); continue; }
    if (c === '}' && stack.at(-1) === '${') { stack.pop(); i = template(i + 1); if (i < 0) return -1; continue; }
    if (c === '}' || c === ')' || c === ']') {
      if (stack.pop() !== { '}': '{', ')': '(', ']': '[' }[c]) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * The skill exposure function in a main bundle, located by its anchors: the one function whose body throws `Bundled CUA skill version mismatch`, looks the
 * skill directory up in the one map of the three skill names, and copies through `.codex-plugin`/`skill-${…}`. `{ error }` when it cannot be located exactly.
 */
export function locateSkillExposure(text) {
  const hits = text.split(MISMATCH).length - 1;
  if (hits !== 1) return { error: `"${MISMATCH}" occurs ${hits} times (expected exactly 1)` };
  const at = text.indexOf(MISMATCH);
  // the skill-directory map: `{[i.Bo]:`control-in-app-browser`,[i.Uo]:`control-chrome`,…,[i.qo]:`computer-use`}`, one map naming all three skills
  const maps = [...text.matchAll(new RegExp(`(?:var|let|const) (${ID})=\\{((?:\\[${ID}(?:\\.${ID})*\\]:${Q}[\\w-]+${Q},?)+)\\}`, 'g'))]
    .filter((m) => SKILL_NAMES.every((s) => new RegExp(`:${Q}${s}${Q}`).test(m[2])));
  if (maps.length !== 1) return { error: `the skill directory map (${SKILL_NAMES.join(', ')}) occurs ${maps.length} times (expected exactly 1)` };
  const map = maps[0][1];
  // the enclosing function: the last `async function N(p){` before the error string whose body reaches past it
  const heads = [...text.slice(0, at).matchAll(new RegExp(`async function (${ID})\\((${ID})\\)\\{`, 'g'))];
  const head = heads.at(-1);
  if (!head) return { error: `no async function encloses "${MISMATCH}"` };
  const start = head.index; const end = matchClose(text, start + head[0].length - 1);
  if (end < 0 || end <= at) return { error: `the function before "${MISMATCH}" (${head[1]}) does not enclose it` };
  const fn = text.slice(start, end);
  try { new vm.Script(`(${fn})`); } catch (e) { return { error: `the located function ${head[1]} does not parse on its own: ${e.message}` }; }
  const need = [`${map}[`, quoted('skills'), quoted('SKILL.md'), quoted('.codex-plugin'), '`skill-${', '.cuaReplSurfaces.includes(', ...WRITES];
  const lacking = need.filter((s) => (typeof s === 'string' ? !fn.includes(s) : !s.test(fn)));
  if (lacking.length) return { error: `the function ${head[1]} that throws "${MISMATCH}" lacks ${lacking.map((s) => `\`${typeof s === 'string' ? s : s.source}\``).join(', ')}` };
  return { name: head[1], param: head[2], start, end, head: head[0], fn, map };
}

/**
 * Every reference to the function must be a call whose value is discarded (an expression statement, or a non-final operand of a comma expression), so
 * returning early changes no caller's data. Returns the references that are not (with context), or `{ error }`.
 */
export function usedResults(text, loc) {
  const out = [];
  for (const m of text.matchAll(new RegExp(`(?<![\\w$.#])${esc(loc.name)}(?![\\w$])`, 'g'))) {
    if (m.index === loc.start + 'async function '.length) continue;                  // the declaration
    const ctx = text.slice(Math.max(0, m.index - 40), m.index + 60);
    const before = text.slice(Math.max(0, m.index - 6), m.index);
    if (before !== 'await ' || text[m.index + loc.name.length] !== '(') { out.push(`not an awaited call: …${ctx}`); continue; }
    const prev = text[m.index - 7];
    const close = matchClose(text, m.index + loc.name.length);
    const next = close < 0 ? '' : text[close];
    const statement = (prev === ';' || prev === '{' || prev === '}') && (next === ';' || next === '}');
    const commaOperand = (prev === ',' || prev === ';' || prev === '{' || prev === '}') && next === ',';
    if (!statement && !commaOperand) out.push(`the call's value may be used: …${ctx}`);
  }
  return out;
}

/**
 * Findings of skill exposure that still writes the plugin cache: the function's body must begin with `return;`. Located by string anchors and structure,
 * never by minified names; a text without the anchors is itself a finding (fail closed), so run it on the main bundle only.
 */
export function exposedCuaSkills(text) {
  const loc = locateSkillExposure(text);
  if (loc.error) return [`anchor not found: the CUA skill exposure (${loc.error}) (fail closed)`];
  return loc.fn.startsWith(`${loc.head}return;`) ? [] : [`${loc.name}() still copies or removes skills in the shared plugin cache`];
}

/**
 * @param {{ list(prefix: string): string[], read(p: string): string }} source
 * @returns {{ drafts: object[], missing: object[] }} the draft for `cua-skills-no-expose` (applied on the main bundle)
 */
export function deriveCuaSkillsTransform(source) {
  const miss = (tried) => ({ drafts: [], missing: [{ item: `transform:${SKILLS_ID}`, mandatory: true, tried }] });
  const found = findMainBundle(source, [MISMATCH, ...SKILL_NAMES]);
  if (found.error) return miss(found.error);
  const { file, text } = found;
  const loc = locateSkillExposure(text);
  if (loc.error) return miss(loc.error);
  const used = usedResults(text, loc);
  if (used.length) return miss(`a caller of ${loc.name} uses its result, so returning early is not a no-op: ${used.join(' | ')}`);
  // the find: the whole function (so its stock text is gone afterwards, like every mandatory edit's site); the text keeps the body as dead code after `return;`
  const find = loc.fn;
  if (text.split(find).length - 1 !== 1) return miss(`the function ${loc.name} occurs more than once in ${file}`);
  const draft = { id: SKILLS_ID, seam: 'other', file, op: 'replace-once', find, text: `${loc.head}return;${find.slice(loc.head.length)}`,
    why: 'N1: the copy does not copy or remove the Computer Use / browser skills (skills/computer-use, skills/control-chrome, skills/control-in-app-browser) in the plugin cache shared with the stock app; the function returns before any filesystem access and its callers discard its result' };
  // dry run: the find applies exactly once, the function now returns first and still parses, and nothing else changed
  let patched;
  try { patched = applyOp(text, draft); } catch (e) { return miss(`dry run failed: ${e.message}`); }
  const left = exposedCuaSkills(patched);
  if (left.length) return miss(`after the dry run the skills are still exposed: ${left.join(' | ')}`);
  return { drafts: [draft], missing: [] };
}
