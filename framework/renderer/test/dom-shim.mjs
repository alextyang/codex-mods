// A tiny DOM for the renderer tests (no dependencies). It implements only what framework/renderer/dom.mjs and the
// tests need: an HTML fixture parser, elements with attributes/classList/dataset, tree edits, a selector engine
// (tag, #id, .class, [attr op value], descendant and child combinators, comma lists, :not(), :has(), :first-child,
// :last-child), a MutationObserver, getComputedStyle for custom properties, matchMedia, keyboard events and a manual clock.

const VOID = new Set(['br', 'img', 'input', 'meta', 'link', 'hr', 'area', 'base', 'col', 'embed', 'source', 'wbr']);

class ShimNode {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling() { const p = this.parentNode; return p ? p.childNodes[p.childNodes.indexOf(this) + 1] ?? null : null; }
  get previousSibling() { const p = this.parentNode; return p ? p.childNodes[p.childNodes.indexOf(this) - 1] ?? null : null; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === this.ownerDocument; }
  contains(other) { for (let n = other; n; n = n.parentNode) if (n === this) return true; return false; }
  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, ref) {
    if (child.parentNode) child.parentNode.removeChild(child);
    const i = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    if (ref && i < 0) throw new Error('insertBefore: reference is not a child');
    this.childNodes.splice(i, 0, child);
    child.parentNode = this;
    this.ownerDocument._record({ type: 'childList', target: this, addedNodes: [child], removedNodes: [] });
    return child;
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i < 0) throw new Error('removeChild: not a child');
    this.childNodes.splice(i, 1);
    child.parentNode = null;
    this.ownerDocument._record({ type: 'childList', target: this, addedNodes: [], removedNodes: [child] });
    return child;
  }
  remove() { this.parentNode?.removeChild(this); }
}

class ShimText extends ShimNode {
  constructor(doc, text) { super(doc); this.nodeType = 3; this.data = text; }
  get textContent() { return this.data; }
}

export class ShimElement extends ShimNode {
  constructor(doc, tag) {
    super(doc);
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attributes = new Map();
    this._listeners = new Map();
    const self = this;
    this.classList = {
      contains: (c) => self._classes().includes(c),
      add: (...cs) => self.setAttribute('class', [...new Set([...self._classes(), ...cs])].join(' ')),
      remove: (...cs) => self.setAttribute('class', self._classes().filter((c) => !cs.includes(c)).join(' ')),
      toggle: (c, force) => { const has = self._classes().includes(c); const want = force ?? !has; if (want !== has) (want ? this.classList.add(c) : this.classList.remove(c)); return want; },
    };
    this.dataset = new Proxy({}, {
      get: (_, k) => self.getAttribute(`data-${String(k).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`) ?? undefined,
      set: (_, k, v) => { self.setAttribute(`data-${String(k).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`, String(v)); return true; },
    });
    this.style = { _p: new Map(), setProperty(k, v) { this._p.set(k, v); }, getPropertyValue(k) { return this._p.get(k) ?? ''; } };
  }
  _classes() { return (this.getAttribute('class') ?? '').split(/\s+/).filter(Boolean); }
  get id() { return this.getAttribute('id') ?? ''; }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get isContentEditable() { const v = this.getAttribute('contenteditable'); return v === '' || v === 'true'; }
  getAttribute(n) { return this.attributes.has(n) ? this.attributes.get(n) : null; }
  hasAttribute(n) { return this.attributes.has(n); }
  setAttribute(n, v) { const old = this.getAttribute(n); this.attributes.set(n, String(v)); this.ownerDocument._record({ type: 'attributes', target: this, attributeName: n, oldValue: old }); }
  removeAttribute(n) { if (this.attributes.delete(n)) this.ownerDocument._record({ type: 'attributes', target: this, attributeName: n }); }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { for (const c of [...this.childNodes]) this.removeChild(c); if (v !== '') this.appendChild(new ShimText(this.ownerDocument, String(v))); }
  matches(sel) { return parseSelectorList(sel).some((cx) => matchComplex(this, cx, this)); }
  closest(sel) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (n.matches(sel)) return n; return null; }
  querySelectorAll(sel) { const list = parseSelectorList(sel); const out = []; walk(this, (el) => { if (el !== this && list.some((cx) => matchComplex(el, cx, this))) out.push(el); }); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  addEventListener(t, fn) { if (!this._listeners.has(t)) this._listeners.set(t, []); this._listeners.get(t).push(fn); }
  removeEventListener(t, fn) { this._listeners.set(t, (this._listeners.get(t) ?? []).filter((f) => f !== fn)); }
  dispatchEvent(ev) { ev.target ??= this; for (const f of this._listeners.get(ev.type) ?? []) f(ev); return !ev.defaultPrevented; }
  click() { this.dispatchEvent({ type: 'click', target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }); }
  focus() { this.ownerDocument.activeElement = this; }
  get outerHTML() {
    const attrs = [...this.attributes].map(([k, v]) => ` ${k}="${v}"`).join('');
    const tag = this.tagName.toLowerCase();
    return VOID.has(tag) ? `<${tag}${attrs}>` : `<${tag}${attrs}>${this.childNodes.map((c) => (c.nodeType === 3 ? c.data : c.outerHTML)).join('')}</${tag}>`;
  }
}

function walk(el, fn) { fn(el); for (const c of el.childNodes) if (c.nodeType === 1) walk(c, fn); }

// ------------------------------------------------------------------ selectors
function splitTop(s, sep) {
  const out = []; let depth = 0, quote = null, cur = '';
  for (const ch of s) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

const cache = new Map();
export function parseSelectorList(sel) {
  if (cache.has(sel)) return cache.get(sel);
  const list = splitTop(sel, ',').map(parseComplex);
  if (list.length === 0) throw new SyntaxError(`empty selector: ${sel}`);
  cache.set(sel, list);
  return list;
}

/** → [{combinator: ' ' | '>' | null, compound}] left to right. */
function parseComplex(s) {
  const parts = []; let i = 0; let comb = null;
  const n = s.length;
  while (i < n) {
    while (i < n && s[i] === ' ') { if (parts.length) comb ??= ' '; i++; }
    if (s[i] === '>') { comb = '>'; i++; continue; }
    if (i >= n) break;
    const [compound, next] = parseCompound(s, i);
    parts.push({ combinator: parts.length ? comb ?? ' ' : null, compound });
    comb = null; i = next;
  }
  if (!parts.length) throw new SyntaxError(`bad selector: ${s}`);
  return parts;
}

function parseCompound(s, i) {
  const c = { tag: null, id: null, classes: [], attrs: [], pseudos: [] };
  const ident = /^[A-Za-z0-9_\-\\*]+/;
  let m;
  if ((m = ident.exec(s.slice(i)))) { c.tag = m[0] === '*' ? null : m[0].toLowerCase(); i += m[0].length; }
  for (;;) {
    const ch = s[i];
    if (ch === '#') { m = ident.exec(s.slice(i + 1)); c.id = m[0]; i += 1 + m[0].length; }
    else if (ch === '.') { m = ident.exec(s.slice(i + 1)); c.classes.push(m[0]); i += 1 + m[0].length; }
    else if (ch === '[') {
      let end = i + 1, q = null;
      for (; end < s.length; end++) { const ch2 = s[end]; if (q) { if (ch2 === '\\') end++; else if (ch2 === q) q = null; } else if (ch2 === '"' || ch2 === "'") q = ch2; else if (ch2 === ']') break; }
      if (end >= s.length) throw new SyntaxError(`unterminated attribute selector in ${s}`);
      const body = s.slice(i + 1, end);
      const am = /^([\w-]+)(?:([~|^$*]?=)(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(.*)))?$/s.exec(body.trim());
      if (!am) throw new SyntaxError(`bad attribute selector [${body}]`);
      const unescape = (v) => (v == null ? v : v.replace(/\\(.)/g, '$1'));
      c.attrs.push({ name: am[1], op: am[2] ?? null, value: unescape(am[3] ?? am[4] ?? am[5] ?? null) });
      i = end + 1;
    } else if (ch === ':') {
      m = /^:([\w-]+)/.exec(s.slice(i));
      let arg = null; i += m[0].length;
      if (s[i] === '(') { let d = 0, j = i; for (; j < s.length; j++) { if (s[j] === '(') d++; if (s[j] === ')' && --d === 0) break; } arg = s.slice(i + 1, j); i = j + 1; }
      c.pseudos.push({ name: m[1], arg });
    } else break;
  }
  if (!c.tag && !c.id && !c.classes.length && !c.attrs.length && !c.pseudos.length && s[i] !== undefined && !/[ >]/.test(s[i])) throw new SyntaxError(`bad selector near ${s.slice(i)}`);
  return [c, i];
}

function matchCompound(el, c, scope) {
  if (c.tag && el.tagName.toLowerCase() !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (const cl of c.classes) if (!el.classList.contains(cl)) return false;
  for (const a of c.attrs) {
    const v = el.getAttribute(a.name);
    if (v === null) return false;
    if (a.op === '=' && v !== a.value) return false;
    if (a.op === '^=' && !v.startsWith(a.value)) return false;
    if (a.op === '$=' && !v.endsWith(a.value)) return false;
    if (a.op === '*=' && !v.includes(a.value)) return false;
    if (a.op === '~=' && !v.split(/\s+/).includes(a.value)) return false;
  }
  for (const p of c.pseudos) {
    if (p.name === 'not') { if (parseSelectorList(p.arg).some((cx) => matchComplex(el, cx, scope))) return false; }
    else if (p.name === 'has') {
      const rel = p.arg.trim();
      const child = rel.startsWith('>');
      const list = parseSelectorList(child ? rel.slice(1) : rel);
      let found = false;
      walk(el, (d) => { if (!found && d !== el && (!child || d.parentNode === el) && list.some((cx) => matchComplex(d, cx, el))) found = true; });
      if (!found) return false;
    } else if (p.name === 'first-child') { if (el.parentNode?.children?.[0] !== el) return false; }
    else if (p.name === 'last-child') { const ch = el.parentNode?.children; if (!ch || ch[ch.length - 1] !== el) return false; }
    else throw new SyntaxError(`unsupported pseudo-class :${p.name}`);
  }
  return true;
}

function matchComplex(el, parts, scope, idx = parts.length - 1) {
  if (!matchCompound(el, parts[idx].compound, scope)) return false;
  if (idx === 0) return true;
  const comb = parts[idx].combinator;
  if (comb === '>') return el.parentNode?.nodeType === 1 && matchComplex(el.parentNode, parts, scope, idx - 1);
  for (let p = el.parentNode; p && p.nodeType === 1; p = p.parentNode) if (matchComplex(p, parts, scope, idx - 1)) return true;
  return false;
}

// ------------------------------------------------------------------ HTML parser
export function parseHtml(doc, html, into) {
  const stack = [into];
  const re = /<!--[\s\S]*?-->|<\/([A-Za-z][\w-]*)\s*>|<([A-Za-z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
  for (let m; (m = re.exec(html));) {
    if (m[0].startsWith('<!--')) continue;
    const top = stack[stack.length - 1];
    if (m[1]) { const i = stack.map((e) => e.tagName?.toLowerCase()).lastIndexOf(m[1].toLowerCase()); if (i > 0) stack.length = i; }
    else if (m[2]) {
      const el = new ShimElement(doc, m[2]);
      for (const a of m[3].matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) el.attributes.set(a[1], a[2] ?? a[3] ?? a[4] ?? '');
      top.childNodes.push(el); el.parentNode = top;
      if (!m[4] && !VOID.has(m[2].toLowerCase())) stack.push(el);
    } else if (m[5] && m[5].trim() !== '') { const t = new ShimText(doc, m[5]); top.childNodes.push(t); t.parentNode = top; }
  }
}

// ------------------------------------------------------------------ document, window
export class ShimDocument extends ShimNode {
  constructor() {
    super(null);
    this.ownerDocument = this;
    this.nodeType = 9;
    this._observers = new Set();
    this._pending = [];
    this._cssVars = new Map();
    this.activeElement = null;
    this.documentElement = new ShimElement(this, 'html');
    this.head = new ShimElement(this, 'head');
    this.body = new ShimElement(this, 'body');
    this.documentElement.childNodes.push(this.head, this.body);
    this.head.parentNode = this.body.parentNode = this.documentElement;
    this.childNodes.push(this.documentElement); this.documentElement.parentNode = this;
  }
  get isConnected() { return true; }
  _record(rec) {
    if (!this._observers.size) return;
    this._pending.push(rec);
    if (this._pending.length === 1) queueMicrotask(() => {
      const recs = this._pending; this._pending = [];
      for (const o of [...this._observers]) {
        const mine = recs.filter((r) => o.matches(r));
        if (mine.length) o.cb(mine, o);
      }
    });
  }
  createElement(tag) { return new ShimElement(this, tag); }
  execCommand(cmd, _ui, value) { if (cmd !== 'insertText' || !this.activeElement) return false; this.activeElement.appendChild(new ShimText(this, value)); return true; }
  querySelector(sel) { return this.documentElement.querySelector(sel) ?? (this.documentElement.matches(sel) ? this.documentElement : null); }
  querySelectorAll(sel) { return this.documentElement.querySelectorAll(sel); }
  setBodyHtml(html) { for (const c of [...this.body.childNodes]) this.body.removeChild(c); parseHtml(this, html, this.body); }
}

export class ManualClock {
  constructor() { this.now = 0; this.timers = []; this.seq = 0; }
  setTimeout = (fn, ms = 0) => { const id = ++this.seq; this.timers.push({ id, at: this.now + ms, fn }); return id; };
  clearTimeout = (id) => { this.timers = this.timers.filter((t) => t.id !== id); };
  tick(ms) {
    const end = this.now + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.now = due.at; due.fn();
    }
    this.now = end;
  }
}

/** A window over a fresh document. `html` becomes the body. */
export function createShimWindow({ html = '', platform = 'MacIntel', search = '', dark = false } = {}) {
  const document = new ShimDocument();
  if (html) document.setBodyHtml(html);
  const clock = new ManualClock();
  const listeners = new Map();
  const mq = { matches: dark, _l: new Set(), addEventListener(_, f) { this._l.add(f); }, removeEventListener(_, f) { this._l.delete(f); } };
  class MutationObserver {
    constructor(cb) { this.cb = cb; this.targets = []; }
    observe(target, opts = {}) { this.targets.push({ target, opts }); document._observers.add(this); }
    disconnect() { document._observers.delete(this); this.targets = []; }
    matches(rec) { return this.targets.some(({ target, opts }) => (opts.subtree ? target.contains(rec.target) : target === rec.target) && (rec.type === 'attributes' ? !!opts.attributes && (!opts.attributeFilter || opts.attributeFilter.includes(rec.attributeName)) : !!opts.childList)); }
  }
  const win = {
    document, MutationObserver, navigator: { platform }, location: { search, href: `app://-/index.html${search}` },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, clock,
    getComputedStyle: () => ({ getPropertyValue: (n) => document._cssVars.get(n) ?? '' }),
    matchMedia: () => mq,
    addEventListener: (t, f) => { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t).add(f); },
    removeEventListener: (t, f) => listeners.get(t)?.delete(f),
    posted: [],
    postMessage(data, targetOrigin, transfer) { this.posted.push({ data, targetOrigin, transfer }); },
    /** Test helper: deliver a 'message' event to window listeners. */
    deliverMessage(init) { const ev = { type: 'message', data: undefined, source: win, ports: [], ...init }; for (const f of [...(listeners.get('message') ?? [])]) f(ev); return ev; },
    /** Test helper: deliver a key event to window listeners (capture phase). */
    key(init) {
      const ev = { type: 'keydown', key: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: document.body, defaultPrevented: false, stopped: false,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...init };
      for (const f of [...(listeners.get('keydown') ?? [])]) f(ev);
      return ev;
    },
    setDark(v) { mq.matches = v; for (const f of mq._l) f(); },
    setVar(name, value) { document._cssVars.set(name, value); document._record({ type: 'attributes', target: document.documentElement, attributeName: 'style' }); },
  };
  win.window = win;
  return win;
}

/** Wait for queued microtasks (MutationObserver deliveries) to run. */
export const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); };
