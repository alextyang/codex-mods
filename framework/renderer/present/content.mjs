// Mods' message content (docs/design/mod-surfaces.md §3.3; a scout of 21477). A part renderer is one
// `host` rule on ContentView's `partRenderers` slot: its part (a fenced code block by language, inline code by a pattern, a link by scheme,
// host or pattern, a directive by name) and its component. The markdown seam passes every markdown site's link and code components
// through the kernel's stable wrappers, which ask `parts(kind, Native, props, at)` here: the first rule in order whose part matches and
// whose sites, `for` and `where` cover the site draws the part, given the app's own component (`Native`, with the exact props) to fall back
// on or to wrap; a rule that throws is off and the app's own shows in its place. The mods' directives join the app's default directives as
// stable components (one per rule), so the app's parser holds a half-written one back while it streams, like its own. `at` is what the
// nearest markdown site binding tells (its binding, site and props); the site's subject comes from that binding. Text (public-hooks.md
// §3.14, H7u): while a mod declares a text part (`ui.content.text`, its component draws each match) or a redaction (`ui.content.redact`,
// add rules on ContentView `redact`: each match shown as its `as`), the pack's markdown text seam asks here for the renderer of every
// text token of a markdown site (`textRenderer(props, renderText)`: the site from its props), which draws the matches and gives the rest
// to the site's own, and for its tokens with code's text masked; the code part masks code too. Redactions come first (their matches
// merged), text parts only between them; a rule sees content only where its mod may read the content's subject. A mask shows and copies
// as its `as` (the original is not in the page). A rule added after a message rendered applies when it renders again. NO NODE API.

import { covers } from './rules.mjs';
import { CONTENT_SITES } from '../../shared/ui-rules-client.mjs';
import { compilePattern } from '../../shared/bounded-pattern.mjs';

const KINDS = new Set(['code', 'inlineCode', 'link', 'directive', 'text']);
/** The longest text a container's string is searched in (a model's paragraph is bounded by this, never a pattern's cost). */
const MAX_TEXT = 100_000;
/** What a redaction shows when it says nothing. */
const MASK = '•••';
/** A token's matches drawn at most (past them, a token a redaction covers is masked whole: never shown for want of looking). */
const MAX_MATCHES = 2_000;
/** A token's search budget: positions read by every rule together (past it, a token a redaction covers is masked whole). */
const MAX_STEPS = 2_000_000;
/** A copy's own bounds (one copy, once: a whole chat as Markdown is searched at once, so a pattern may span its lines). */
const COPY_TEXT = 2_000_000;
const COPY_STEPS = 40_000_000;
const COPY_MATCHES = 100_000;
/** The masked code texts a window remembers having drawn (a copy of exactly one keeps its masks): at most this many, of this many characters. */
const DRAWN_MAX = 500;
const DRAWN_CHARS = 2_000_000;
/**
 * A text token's text as the app gives it to its renderer is escaped, decoded as the app's decoder does: a reference ends with `;`, a
 * named one as the page's own parser knows it (a textarea's content is text, never markup), a numeric one a code point (none: as written).
 */
let decoder = null;
const ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" });
function named(name) {
  try { if (typeof document !== 'undefined' && document.createElement) { decoder ??= document.createElement('textarea'); decoder.innerHTML = `&${name};`; const v = decoder.value; return v === `&${name};` ? null : v; } } catch { /* below */ }
  return Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : null;
}
const decode = (s) => (s.includes('&') ? s.replace(/&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g, (m, dec, hex, name) => {
  if (name) return named(name) ?? m;
  const n = dec ? parseInt(dec, 10) : parseInt(hex, 16);
  return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : m;
}) : s);
const encode = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/** The prop the app's link renderer gets the link's own text in (the label as written, before any rendering). */
const LINK_TEXT = 'data-markdown-raw-link-label';
/** The longest inline code a pattern is tried on (a link's href: eight times as long): the model's text is unbounded, a pattern's cost is not. */
const MAX_MATCHED = 256;
/** A part's pattern, for the bounded matcher (linear in the text: the model's text never makes a mod's pattern backtrack; review 4, round 2). */
const patternOf = (m) => { try { return m && typeof m.source === 'string' ? compilePattern(m.source, typeof m.flags === 'string' ? m.flags : '') : null; } catch { return null; } };
/** The text of a part's children as the app gave them (strings and numbers; anything else is no text). */
export const textOf = (c) => (typeof c === 'string' ? c : typeof c === 'number' ? String(c) : Array.isArray(c) ? c.map(textOf).join('') : '');

/** A part renderer as its rule says it, checked: null when the rule is not one (or its component is not in this window). */
export function partOf(r) {
  const p = r?.data?.part;
  const render = r?.fns?.render;
  if (!p || typeof p !== 'object' || !KINDS.has(p.kind) || typeof render !== 'function') return null;
  const sites = Array.isArray(p.sites) ? p.sites.filter((s) => CONTENT_SITES.includes(s)) : [];
  const base = { key: `${r.mod}/${r.id}`, rule: r, kind: p.kind, render, sites: sites.length ? new Set(sites) : null, native: p.whileStreaming === 'native' };
  if (p.kind === 'code') {
    const languages = (Array.isArray(p.language) ? p.language : []).filter((l) => typeof l === 'string' && l).map((l) => l.toLowerCase());
    return languages.length ? { ...base, languages: new Set(languages) } : null;
  }
  if (p.kind === 'inlineCode' || p.kind === 'text') { const match = patternOf(p.match); return match ? { ...base, match } : null; }
  if (p.kind === 'link') {
    const schemes = Array.isArray(p.scheme) ? new Set(p.scheme) : null;
    const hosts = Array.isArray(p.host) ? p.host.filter((h) => typeof h === 'string').map((h) => h.toLowerCase()) : null;
    const match = p.match === undefined ? null : patternOf(p.match);
    if ((p.match !== undefined && !match) || (!schemes && !hosts && !match)) return null;
    return { ...base, schemes, hosts, match };
  }
  return typeof p.name === 'string' && p.name ? { ...base, name: p.name, group: p.groupConsecutive === true } : null;
}

/** A redaction as its rule says it, checked: null when the rule is not one. */
export function redactOf(r) {
  const x = r?.kind === 'add' && r.slot === 'redact' ? r.data?.redact : null;
  const match = x ? patternOf(x.match) : null;
  if (!match) return null;
  const sites = Array.isArray(x.sites) ? x.sites.filter((s) => CONTENT_SITES.includes(s)) : [];
  return { key: `${r.mod}/${r.id}`, rule: r, kind: 'redact', match, as: typeof x.as === 'string' ? x.as.slice(0, 40) : MASK, sites: sites.length ? new Set(sites) : null };
}
/** A link's parts as the app gave them: its href (as the app's sanitiser left it), its text and title, its scheme and host. */
function linkOf(props) {
  const href = typeof props?.href === 'string' && props.href ? props.href : null;
  if (!href) return null;
  let url = null;
  try { url = new URL(href); } catch { /* a relative or file link: no scheme, no host */ }
  return Object.freeze({
    href, text: typeof props[LINK_TEXT] === 'string' ? props[LINK_TEXT] : textOf(props.children), ...(typeof props.title === 'string' && props.title ? { title: props.title } : {}),
    scheme: url ? url.protocol.replace(/:$/, '') : null, host: url && url.hostname ? url.hostname.toLowerCase() : null,
  });
}
/** A code element's part: inline code, or a fenced block with its language and whether its fence is still open (it is streaming). */
function codeOf(props) {
  if (props?.inline === true) return { kind: 'inlineCode', part: Object.freeze({ text: textOf(props.children) }), streaming: false };
  const info = typeof props?.['data-code-block-info'] === 'string' ? props['data-code-block-info'] : '';
  const cls = typeof props?.className === 'string' ? /(?:^|\s)language-(\S+)/.exec(props.className)?.[1] : undefined;
  const language = String(cls ?? info.trim().split(/\s+/)[0] ?? '').toLowerCase();
  const open = props?.isCodeFenceOpen === true;
  return { kind: 'code', part: Object.freeze({ language, info, text: textOf(props?.children), raw: typeof props?.rawText === 'string' ? props.rawText : '', open }), streaming: open };
}
const claims = (p, kind, part) => {
  if (p.kind !== kind) return false;
  if (kind === 'code') return p.languages.has(part.language);
  if (kind === 'inlineCode') { if (part.text.length > MAX_MATCHED) return false; return p.match.test(part.text); }
  if (kind === 'link') {
    if (p.schemes && !p.schemes.has(part.scheme)) return false;
    if (p.hosts && !(part.host && p.hosts.some((h) => part.host === h || part.host.endsWith(`.${h}`)))) return false;
    if (p.match) { if (part.href.length > MAX_MATCHED * 8) return false; if (!p.match.test(part.href)) return false; }
    return true;
  }
  return false;
};

/**
 * @param {{ react: () => any, rules: { trip(rule: object, e: unknown): void, tripped(): string[] }, chainOf: (type: string) => string[],
 *   site: () => any, use: (compute: () => unknown) => unknown, subjectOf: (at: object | null) => object | null, instance: (ref: object) => object | null,
 *   onConflict?: (loser: object, winner: object) => void }} o
 *   `site()`: the kernel's site context; `use(compute)`: a hook that runs `compute` and re-renders its component when the part renderers
 *   change or a subject it read is touched (a directive's; the kernel's part wrappers do the same for links and code);
 *   `subjectOf(at)`: the subject a markdown site's binding names; `instance(ref)`: its instance (for `for`/`where`)
 */
export function createContent(o) {
  let list = [];                 // the part renderers, in order
  let redacts = [];              // the redactions, in order
  let version = 0;               // the rules' (a renderer given for older rules is not given again)
  let byKey = new Map();
  let names = '';                // the mods' directive names, as last set
  const told = new Set();
  const tell = (loser, winner) => {
    const k = `${loser.mod}/${loser.id}>${winner.mod}/${winner.id}`;
    if (told.has(k)) return;
    told.add(k);
    try { o.onConflict?.(loser, winner); } catch { /* the reporter's own fault */ }
  };
  const off = (p) => o.rules.tripped().includes(p.key);

  /** A mod's part in its boundary: a throw trips its rule alone and the app's own rendering shows in its place. */
  const boundaries = new WeakMap();
  function boundaryOf(R) {
    let B = boundaries.get(R);
    if (!B) {
      B = class CodexmodsPartBoundary extends R.Component {
        constructor(props) { super(props); this.state = { failed: false }; }
        static getDerivedStateFromError() { return { failed: true }; }
        componentDidCatch(error) { try { o.rules.trip(this.props.rule, error); } catch { /* reporting must not throw */ } }
        render() { return this.state.failed ? this.props.fallback : this.props.children; }
      };
      boundaries.set(R, B);
    }
    return B;
  }
  /** Where a part is: its site and subject, and the instance for a rule's `for` and `where` (looked up once, when a rule asks). */
  function placeOf(at) {
    const site = at && typeof at.site === 'string' && CONTENT_SITES.includes(at.site) ? at.site : 'other';
    let subject;
    let inst;
    return {
      site,
      // a site binding's subject; a markdown renderer's (the text seam): the chat its props name
      get subject() {
        if (subject === undefined) {
          try { subject = at && at.conversationId !== undefined ? (at.conversationId && typeof o.threadOf === 'function' ? o.threadOf(at.conversationId) ?? null : null) : o.subjectOf(at) ?? null; } catch { subject = null; }
        }
        return subject;
      },
      covers(p) {
        if (p.sites && !p.sites.has(site)) return false;
        // content goes to a rule only where its mod may read the content's subject (its type's read grant, or its own: from the ref); a
        // text part's component gets the text, so it waits for a subject (one still being looked up, or none, gives it nothing)
        const ref = this.subject;
        if (ref && typeof o.may === 'function' && !o.may(p.rule, { ref })) return false;
        if (!ref && p.kind === 'text') return false;
        if (!p.rule.for && !p.rule.where) return true;
        if (inst === undefined) inst = ref ? o.instance(ref) ?? null : null;
        return covers(p.rule, inst, o.chainOf, typeof o.whereEnv === 'function' ? () => o.whereEnv(p.rule) : undefined);
      },
    };
  }
  /** The first part renderer that claims this part here; the others that would are told they lost. */
  function claimOf(kind, part, place) {
    let won = null;
    for (const p of list) {
      if (p.kind === 'directive' || p.kind === 'text' || off(p) || !claims(p, kind, part) || !place.covers(p)) continue;
      if (!won) won = p; else tell(p.rule, won.rule);
    }
    return won;
  }
  function draw(R, p, part, place, streaming, Native, nativeProps, fallback) {
    const props = { part, site: place.site, subject: place.subject, streaming, Native, nativeProps, children: nativeProps?.children };
    // keyed by its rule: another rule taking the part starts a boundary of its own (not one an earlier rule's failure left failed)
    return R.createElement(boundaryOf(R), { key: p.key, rule: p.rule, fallback }, R.createElement(p.render, props));
  }

  /** A text part's stand-in for the app's own: the matched text as it was. */
  const TextNative = (props) => props?.children ?? null;
  /**
   * A string's pieces with the redactions and the text parts given: null when nothing matches. The redactions first, against the text as
   * it is (their matches merged: an overlap is one mask, the earliest and then longest match's `as`); then the text parts, each match in
   * the whole text (its assertions read what is around it) that no mask overlaps, the earliest first, the rules' order breaking ties. Each
   * piece `{text}`, `{text, redact}` or `{text, part}`. One budget for the whole token (every rule's search, every match): a text too long
   * to read, or one that spends it, is one mask when a redaction covers it (never shown for want of looking), else as it is.
   */
  function piecesOf(text, redactRules, partRules) {
    if (!text) return null;
    const whole = () => (redactRules.length ? [{ text, redact: redactRules[0] }] : null);
    if (text.length > MAX_TEXT) return whole();
    const budget = { left: MAX_STEPS, matches: 0 };
    const cuts = [];
    for (const r of redactRules) {
      for (let pos = 0; ;) {
        const m = r.match.find(text, pos, budget);
        if (budget.out || ++budget.matches > MAX_MATCHES) return whole();
        if (!m || m.end <= m.start) break;
        cuts.push([m.start, m.end, r]);
        pos = m.end;
      }
    }
    cuts.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const merged = [];
    for (const c of cuts) { const last = merged[merged.length - 1]; if (last && c[0] < last[1]) last[1] = Math.max(last[1], c[1]); else merged.push([...c]); }
    // the text parts' matches no mask overlaps
    const found = [];
    if (partRules.length) {
      const overlaps = (a, b) => merged.some(([x, y]) => a < y && b > x);
      const next = new Map();
      let pos = 0;
      for (;;) {
        let won = null, at = null;
        for (const r of partRules) {
          let m = next.get(r);
          // a rule's next match at or after `pos` that no mask overlaps
          while (m === undefined || (m && (m.start < pos || overlaps(m.start, m.end)))) {
            const from = m === undefined || m.start < pos ? pos : m.start + 1;
            m = from > text.length ? null : r.match.find(text, from, budget);
            if (budget.out || ++budget.matches > MAX_MATCHES) { if (redactRules.length) return whole(); m = null; break; }
            if (m && m.end <= m.start) m = null;
          }
          next.set(r, m);
          if (m && (!at || m.start < at.start)) { won = r; at = m; }
        }
        if (!won) break;
        found.push([at.start, at.end, won]);
        pos = at.end;
      }
    }
    if (!merged.length && !found.length) return null;
    const all = [...merged.map(([a, b, r]) => [a, b, { redact: r }]), ...found.map(([a, b, r]) => [a, b, { part: r }])].sort((x, y) => x[0] - y[0]);
    const out = [];
    let pos = 0;
    for (const [a, b, kind] of all) { if (a > pos) out.push({ text: text.slice(pos, a) }); out.push({ text: text.slice(a, b), ...kind }); pos = b; }
    if (pos < text.length) out.push({ text: text.slice(pos) });
    return out;
  }
  /** A string with its redactions masked (code, read as it is written): undefined when none applies. Remembered as drawn, with its masks. */
  function masked(text, redactRules) {
    if (typeof text !== 'string' || !redactRules.length) return undefined;
    const pieces = piecesOf(text, redactRules, []);
    if (!pieces) return undefined;
    let out = '';
    const spans = [];
    for (const x of pieces) {
      if (x.redact) { if (x.redact.as) spans.push([out.length, out.length + x.redact.as.length]); out += x.redact.as; } else out += x.text;
    }
    remember(out, spans);
    return out;
  }
  // The masked code texts the page drew (a code block's, as its tokens give it: its Copy copies exactly that text), each with its masks'
  // places in order: a copy of exactly such a text keeps those masks as drawn (never masked again), and only those. Provenance is the
  // framework's own record of what it drew, never a mask's text found in a copy (a copied text that only contains it is masked as any).
  const drawn = new Map();
  let drawnChars = 0;
  function remember(text, spans) {
    if (!spans.length || text.length > DRAWN_CHARS) return;
    if (drawn.delete(text)) drawnChars -= text.length;
    drawn.set(text, spans);
    drawnChars += text.length;
    for (const k of drawn.keys()) {
      if (drawn.size <= DRAWN_MAX && drawnChars <= DRAWN_CHARS) break;
      drawn.delete(k);
      drawnChars -= k.length;
    }
  }
  /** A redaction's mask: its `as`, read as the text around it (it copies as shown: the original is not in the page). */
  const mask = (R, r, key) => R.createElement('span', { key, 'data-codexmods-redacted': r.rule.mod }, r.as);

  /** The site a markdown renderer's props say: the agent's message, the user's, or another (reasoning and the plan are `other` here). */
  const siteOfProps = (props) => (props?.textStyle?.kind === 'assistant-message' ? 'agent-message' : props?.textStyle?.tone === 'user-message' ? 'user-message' : 'other');
  /** Does a markdown renderer's message still stream (tokens still coming, a fence still open)? */
  const streamingOf = (props) => {
    const keys = props?.streamingTokenKeys;
    return props?.openCodeFenceToken != null || (keys != null && (typeof keys.size === 'number' ? keys.size > 0 : Array.isArray(keys) && keys.length > 0));
  };
  const originals = new WeakMap();   // a code token -> its own {text, raw}, as the app made it (the masks are always made from it)
  const MAX_DEPTH = 1_000;
  /**
   * Code's text masked in a markdown renderer's own tokens (fenced and inline: every site's, the user's message's own code drawing too),
   * in place: each code token keeps its identity (the app keys an open fence and its decorations by it) and its own text, from which
   * every render masks again (a rule gone gives it back). A fence's raw is written again around its masked text.
   */
  function maskTokens(tokens, redactRules) {
    const seen = new Set();
    const walk = (x, depth) => {
      if (!x || typeof x !== 'object' || seen.has(x)) return;
      seen.add(x);
      if (Array.isArray(x)) { for (const y of x) walk(y, depth + 1); return; }
      if ((x.type === 'code' || x.type === 'codespan') && (typeof x.text === 'string' || originals.has(x))) {
        const own = originals.get(x) ?? { text: x.text, raw: x.raw };
        originals.set(x, own);
        // too deep to be sure of what is under it: masked whole (never shown for want of looking)
        const m = depth > MAX_DEPTH && redactRules.length ? redactRules[0].as : masked(own.text, redactRules);
        if (m === undefined) { x.text = own.text; if (own.raw !== undefined) x.raw = own.raw; }
        else {
          x.text = m;
          if (typeof own.raw === 'string') {
            x.raw = x.type === 'codespan' ? `\`${m}\`` : x.codeBlockStyle === 'indented' ? m.split('\n').map((l) => `    ${l}`).join('\n')
              : `\`\`\`${typeof x.lang === 'string' ? x.lang : ''}\n${m}\n\`\`\``;
          }
        }
      }
      if (depth > MAX_DEPTH) return;
      for (const k of ['tokens', 'items', 'header', 'rows']) if (Array.isArray(x[k])) walk(x[k], depth + 1);
    };
    walk(tokens, 0);
  }
  const NO_RENDER = {};   // the cache's key for a site that gives no renderText
  const renderers = new WeakMap();   // the site's renderText -> `${site}|${rules}|${version}` -> the stable renderer given for it
  /**
   * The markdown text seam asks here (`markdownText(props, renderText)`): the renderer of a markdown site's text tokens with the text parts
   * and redactions that cover it (its own tokens' code masked in place), or the site's own renderer when none does. Stable for the same
   * site, rules, streaming and renderText (the app memoizes on it).
   */
  function textRenderer(props, renderText) {
    if (!list.some((p) => p.kind === 'text' && !off(p)) && !redacts.some((r) => !off(r))) {
      if (Array.isArray(props?.tokens)) maskTokens(props.tokens, []);   // what an earlier rule masked comes back
      return renderText;
    }
    const site = siteOfProps(props);
    const conversation = typeof props?.conversationId === 'string' ? props.conversationId : null;
    const place = placeOf({ site, conversationId: conversation });
    const streaming = streamingOf(props);
    const redactRules = redacts.filter((r) => !off(r) && place.covers(r));
    // a text part that draws only once a message is done gives way to the app's own while it streams
    const partRules = list.filter((p) => p.kind === 'text' && !off(p) && !(p.native && streaming) && place.covers(p));
    if (Array.isArray(props?.tokens)) maskTokens(props.tokens, redactRules);
    if (!redactRules.length && !partRules.length) return renderText;
    const key = `${site}|${conversation ?? ''}|${streaming ? 's' : 'd'}|${[...redactRules, ...partRules].map((r) => r.key).join(',')}|${version}`;
    const own = typeof renderText === 'function' ? renderText : null;
    let byKey = renderers.get(own ?? NO_RENDER);
    if (!byKey) renderers.set(own ?? NO_RENDER, (byKey = new Map()));
    let fn = byKey.get(key);
    if (fn) return fn;
    fn = (text, keyPrefix, token, decorateText) => {
      const R = o.react();
      const raw = String(text ?? '');
      const pieces = R ? piecesOf(decode(raw), redactRules, partRules) : null;
      if (!pieces) return own ? own(text, keyPrefix, token, decorateText) : text;   // as the app draws it, untouched
      return pieces.map((x, i) => {
        const k = `${keyPrefix ?? 't'}-cm${i}`;
        if (x.redact) return mask(R, x.redact, k);
        if (x.part) return R.createElement(R.Fragment, { key: k }, draw(R, x.part, Object.freeze({ text: x.text }), place, streaming, TextNative, { children: x.text }, x.text));
        // the rest as the site draws it: its text as the app gave it (escaped), on a token of its own (its streaming fade is the whole
        // token's: a piece fades by itself)
        const enc = encode(x.text);
        return R.createElement(R.Fragment, { key: k }, own ? own(enc, k, token && typeof token === 'object' ? { ...token, text: enc } : token, decorateText) : enc);
      });
    };
    if (byKey.size > 64) byKey.clear();
    byKey.set(key, fn);
    return fn;
  }

  /**
   * The kernel's part wrappers ask here: a mod's part for the app's link (`a`) or code element, or undefined for the app's own. (Code comes
   * here masked: the text seam masks the renderer's tokens before any code is drawn.)
   */
  function parts(kind, Native, props, at) {
    if (!list.length) return undefined;
    const R = o.react();
    if (!R) return undefined;
    const got = kind === 'code' ? codeOf(props) : kind === 'a' ? (() => { const part = linkOf(props); return part ? { kind: 'link', part, streaming: false } : null; })() : null;
    if (!got) return undefined;
    const place = placeOf(at);
    const p = claimOf(got.kind, got.part, place);
    if (!p || (p.native && got.streaming)) return undefined;
    void place.subject;   // read while the kernel records: the part renders again when the site's subject resolves
    return draw(R, p, got.part, place, got.streaming, Native, props, R.createElement(Native, props));
  }

  /** The text a directive shows when no mod draws it (outside its rules' sites, or after they failed): its own content. */
  const DirectiveText = (props) => props?.children ?? props?.rawText ?? null;
  const directiveTypes = new Map();   // directive name -> its stable component (the app renders a directive as a component type)
  /** One component per name: where it renders, the first rule in order with that name that covers the site draws it. */
  function directiveType(name) {
    let T = directiveTypes.get(name);
    if (T) return T;
    T = function CodexmodsDirective(props) {
      const R = o.react();
      const ctx = o.site();
      const at = ctx ? R.useContext(ctx) : null;
      return o.use(() => {
        const text = R.createElement(DirectiveText, props);
        const place = placeOf(at);
        let p = null;
        for (const q of list) {
          if (q.kind !== 'directive' || q.name !== name || off(q) || !place.covers(q)) continue;
          if (!p) p = q; else tell(q.rule, p.rule);
        }
        if (!p) return text;
        const part = Object.freeze({
          name, attributes: Object.freeze({ ...(props.attributes ?? {}) }),
          ...(Array.isArray(props.groupedAttributes) ? { groupedAttributes: Object.freeze(props.groupedAttributes.map((a) => Object.freeze({ ...(a ?? {}) }))) } : {}),
          ...(typeof props.rawText === 'string' ? { rawText: props.rawText } : {}), isBlock: props.isBlock === true, isLastBlock: props.isLastBlock === true,
        });
        // the subject is read here, so a site whose subject resolves later renders its directive again
        void place.subject;
        return draw(R, p, part, place, false, DirectiveText, props, text);
      });
    };
    T.displayName = `CodexmodsDirective(${name})`;
    directiveTypes.set(name, T);
    return T;
  }
  /** The app's default directives with the mods' own names: a name of the app's stays the app's (its rules are told they lost). */
  function directives(options, defaults) {
    const mine = list.filter((p) => p.kind === 'directive' && !off(p));
    if (!mine.length || !defaults || typeof defaults !== 'object') return defaults;
    const out = { ...defaults };
    const seen = new Set();
    for (const p of mine) {
      if (Object.prototype.hasOwnProperty.call(defaults, p.name)) { tell(p.rule, { mod: 'app', id: p.name }); continue; }
      if (seen.has(p.name)) continue;
      seen.add(p.name);
      const T = directiveType(p.name);
      T.groupConsecutive = p.group;   // the first rule's (the parser groups before any rule is chosen)
      out[p.name] = T;
    }
    return out;
  }

  /**
   * A copied text with `rules` masked (the copy seam, F3): the whole text at once (a pattern may span its lines), up to a copy's own bound
   * (past it, or past its search budget, one mask: never copied for want of looking); every rule against the original (their matches
   * merged, as on screen). A text the page drew masked (`drawn`: a code block's, copied whole) keeps its masks: a match on one, or crossing
   * one, is not masked again; the masks' places are walked in order as the matches come, on the same budget.
   */
  function maskCopy(text, rules) {
    if (!text) return text;
    if (text.length > COPY_TEXT) return rules[0].as;
    const budget = { left: COPY_STEPS, matches: 0 };
    const kept = drawn.get(text) ?? null;
    const cuts = [];
    for (const r of rules) {
      let j = 0;
      for (let pos = 0; ;) {
        const m = r.match.find(text, pos, budget);
        if (budget.out || ++budget.matches > COPY_MATCHES) return rules[0].as;
        if (!m || m.end <= m.start) break;
        while (kept && j < kept.length && kept[j][1] <= m.start) { j++; if (--budget.left < 0) return rules[0].as; }
        if (!(kept && j < kept.length && kept[j][0] < m.end)) cuts.push([m.start, m.end, r]);
        pos = m.end;
      }
    }
    if (!cuts.length) return text;
    cuts.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const merged = [];
    for (const c of cuts) { const last = merged[merged.length - 1]; if (last && c[0] < last[1]) last[1] = Math.max(last[1], c[1]); else merged.push([...c]); }
    let out = '', pos = 0;
    for (const [a, b, r] of merged) { out += text.slice(pos, a) + r.as; pos = b; }
    return out + text.slice(pos);
  }
  /**
   * The redactions a copy of chats' content is masked by (in order): each chat's (a rule's `for` and `where`, and whether its mod may read
   * it, read on it), whatever sites they name (a copy mixes them); every redaction when a chat is not known (masking more is the safe way).
   */
  function copyRules(chats) {
    const all = new Set();
    for (const chat of chats) for (const r of chatRules(chat)) all.add(r);
    return redacts.filter((r) => all.has(r));
  }
  function chatRules(chat) {
    const inst = chat ? o.instance(chat) ?? null : null;
    return redacts.filter((r) => {
      if (off(r)) return false;
      if (!chat) return true;
      if (typeof o.may === 'function' && !o.may(r.rule, { ref: chat })) return false;
      if (!r.rule.for && !r.rule.where) return true;
      // a chat the window does not hold now: its conditions cannot be read, so it is masked (the safe way)
      if (!inst) return true;
      return covers(r.rule, inst, o.chainOf, typeof o.whereEnv === 'function' ? () => o.whereEnv(r.rule) : undefined);
    });
  }
  /**
   * What the app copies of chats' content (the copy seam, F3: its copy buttons and menus build what they copy from the chat's data,
   * mostly not from what the page shows), its text masked by `copyRules(chats)`: a string, a promise of one (its own `then`), or the app's
   * {"text/plain", "text/html"} as its masked text alone (its html cannot be masked as text: an attribute, a link's address, keeps what it
   * says). Null when no rule applies.
   */
  function copyMasked(content, chats) {
    const rules = copyRules(chats);
    if (!rules.length) return null;
    const mask = (text) => (typeof text === 'string' ? maskCopy(text, rules) : text);
    if (typeof content === 'string') return mask(content);
    if (content && typeof content.then === 'function') return content.then(mask);
    if (content && typeof content === 'object' && typeof content['text/plain'] === 'string') return { 'text/plain': mask(content['text/plain']) };
    return null;
  }
  /** One format a selection's copy sets (its `setData`): its text masked, its html left out (false) when a rule applies; null: as it is. */
  function copyPart(type, data, chats) {
    const rules = copyRules(chats);
    if (!rules.length) return null;
    if (type === 'text/html') return false;
    return type === 'text/plain' ? maskCopy(data, rules) : null;
  }

  return {
    parts,
    directives,
    copyMasked,
    copyPart,
    /**
     * The part renderers and redactions of the window's rules (the runtime calls it as rules change); true when the mods' directive names
     * changed.
     */
    setRules(rules) {
      version++;
      const order = (a, b) => a.rule.order - b.rule.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
      list = rules.map(partOf).filter(Boolean).sort(order);
      redacts = rules.map(redactOf).filter(Boolean).sort(order);
      byKey = new Map(list.map((p) => [p.key, p]));
      for (const k of [...told]) { const [loser, winner] = k.split('>'); if (!byKey.has(loser) || (!byKey.has(winner) && !winner.startsWith('app/'))) told.delete(k); }
      const firsts = new Map();
      for (const p of list) if (p.kind === 'directive' && !firsts.has(p.name)) firsts.set(p.name, p.group);
      const next = [...firsts].map(([n, g]) => `${n}:${g}`).sort().join(',');
      const changed = next !== names;
      names = next;
      return changed;
    },
    list: () => list,
    textRenderer,
  };
}
