// The mods' `style` rules in the page (docs/design/systems.md S7, S12): a mod sets the app's own CSS variables, wherever the app sets them, to theme tokens while it
// runs, never to a raw value (the theme owns colours and fonts, release-2 §7), so what it sets follows the theme. One owner per variable:
// the first rule in order holds it, the others are told (a conflict); removing a rule gives the variable to the next owner, or back to
// the app's own value. The variables go in one style sheet of their own, which wins over the app's own values on <html>. They stop at the
// framework's roots (E6 decision 6, E6.4b): there each variable a rule sets is declared again with the app's own value, read with the rules
// taken out a moment and read again when the theme changes, so no mod restyles the framework's pages, band or dialogs. NO NODE API.

/** What marks a root of the framework's own UI (its Settings pages, the Mods navigation, the band, its Dialogs, the recovery entry). */
export const FRAMEWORK_ROOT = '[data-codexmods-framework]';
/** Where the rules' variables are set: the root and every element under it; the framework's roots and theirs take the app's values again. */
const ALL = ':root, :root *';
const FRAMEWORK_ALL = `${FRAMEWORK_ROOT}, ${FRAMEWORK_ROOT} *`;
/** A value the app's own computed style gave, safe to write back in a declaration. */
const SAFE = /^[^{};<>\\]*$/;

const VAR = /^--[A-Za-z0-9_-]{1,80}$/;
const TOKEN = /^[A-Za-z][A-Za-z0-9]{0,40}$/;

/**
 * What the style rules set: the CSS and who holds each variable.
 * @param {object[]} rules  the style rules in order (`data.variables`: {"--app-variable": "token" | "--app-variable"})
 * @param {{ tokens: Record<string, string>, known: (variable: string) => boolean, appValues?: (variables: string[]) => Record<string, string>,
 *   protectRoots?: (rootCss: string) => Record<string, string> }} o  `protectRoots` (preferred): every variable the rules' CSS changes,
 *   aliases included, with the app's own value; `appValues` (else): the app's values of the variables set, declared again at the roots
 *   `tokens`: the adapter's theme map (token name -> CSS custom property); `known`: whether a variable is the app's own; `appValues`: the
 *   app's own values of those variables (without any rule), declared again at the framework's roots
 * @returns {{ css: string, owners: Map<string, string>, conflicts: { rule: string, variable: string, holder: string }[],
 *   refused: { rule: string, variable: string, why: string }[] }}
 */
export function stylesOf(rules, o) {
  const owners = new Map();   // variable -> the rule's key
  const values = new Map();   // variable -> its CSS value
  const conflicts = [], refused = [];
  const tokenVars = new Set(Object.values(o.tokens ?? {}).filter((v) => typeof v === 'string' && VAR.test(v)));
  const appVar = (v) => VAR.test(v) && (tokenVars.has(v) || o.known(v));
  for (const r of rules) {
    const key = `${r.mod}/${r.id}`;
    for (const [variable, value] of Object.entries(r.data?.variables ?? {})) {
      if (!appVar(variable)) { refused.push({ rule: key, variable, why: 'not one of the app\'s own variables' }); continue; }
      // `{light, dark}`: the one for the appearance the theme shows now (the page styles again when it changes)
      const v = value && typeof value === 'object' ? value[o.appearance === 'dark' ? 'dark' : 'light'] : value;
      const target = typeof v !== 'string' ? null : VAR.test(v) ? v : TOKEN.test(v) ? o.tokens?.[v] : null;
      if (!target || !appVar(target)) { refused.push({ rule: key, variable, why: 'a style takes a theme token or one of the app\'s variables' }); continue; }
      if (owners.has(variable)) { conflicts.push({ rule: key, variable, holder: owners.get(variable) }); continue; }
      owners.set(variable, key);
      values.set(variable, `var(${target})`);
    }
  }
  const body = [...values].map(([k, v]) => `${k}: ${v} !important;`).join(' ');
  let kept = '';
  if (body && typeof o.protectRoots === 'function') {
    const changed = o.protectRoots(`:root { ${body} }`) ?? {};
    kept = Object.entries(changed).filter(([k, v]) => VAR.test(k) && typeof v === 'string' && v !== '' && SAFE.test(v)).map(([k, v]) => `${k}: ${v} !important;`).join(' ');
  } else if (body && typeof o.appValues === 'function') {
    const app = o.appValues([...values.keys()]) ?? {};
    kept = [...values.keys()].filter((k) => typeof app[k] === 'string' && app[k] !== '' && SAFE.test(app[k])).map((k) => `${k}: ${app[k]} !important;`).join(' ');
  }
  // on every element, not only the root: the app sets many of its variables deeper (a chat's width on its thread, a row's height on its
  // list, through its own utility classes), and an element's own declaration would win over one it inherits from the root; the
  // framework's roots and everything in them again take the app's own values (a more specific selector of the same importance)
  return { css: body ? `${ALL} { ${body} }${kept ? ` ${FRAMEWORK_ALL} { ${kept} }` : ''}` : '', owners, conflicts, refused };
}

/**
 * Keeps the page's style sheet in step with the style rules.
 * @param {{ tokens: Record<string, string>, cssVar?: (name: string) => string, sink?: (css: string) => void,
 *   appValues?: (variables: string[]) => Record<string, string>, protectRoots?: (rootCss: string) => Record<string, string>,
 *   log?: (m: string, d?: object) => void }} o  `sink`: replaces the page's
 *   style sheet of the rules (empty: none); `appValues`: the app's own values, for the framework's roots
 */
export function createStyles(o) {
  const log = o.log ?? (() => {});
  let last = '', told = new Set();
  return {
    /** The style rules changed (or may have): apply them in order. */
    apply(rules) {
      const r = stylesOf(rules, { tokens: o.tokens ?? {}, known: (v) => (o.cssVar?.(v) ?? '') !== '', appValues: o.appValues, protectRoots: o.protectRoots, appearance: o.appearance?.() ?? 'light' });
      const now = new Set();
      for (const c of r.conflicts) {
        const k = `c ${c.rule} ${c.variable}`;
        now.add(k);
        if (!told.has(k)) log('a style rule lost a variable to another', { rule: c.rule, variable: c.variable, to: c.holder });
      }
      for (const x of r.refused) {
        const k = `r ${x.rule} ${x.variable}`;
        now.add(k);
        if (!told.has(k)) log('a style rule was refused', x);
      }
      told = now;
      if (r.css !== last) { last = r.css; try { o.sink?.(r.css); } catch (e) { log('the style sheet could not be set', { message: String(e?.message ?? e) }); } }
      return r;
    },
  };
}
