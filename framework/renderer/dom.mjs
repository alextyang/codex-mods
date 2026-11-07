// The ONLY module in the renderer runtime that touches `window` / `document`. Everything else receives a Dom.
// Tests build a Dom over test/dom-shim.mjs (a tiny DOM written for them); production uses createDom(window).

/**
 * @typedef {object} Dom
 * @property {(selector: string) => Element | null} query        throws SyntaxError on an invalid selector
 * @property {(selector: string) => Element[]} queryAll
 * @property {(tag: string, attrs?: Record<string,string>) => Element} createElement
 * @property {(anchorEl: Element, node: Element, position: 'append'|'prepend'|'before'|'after') => void} insert
 * @property {(position: string, node: Element, anchorEl: Element) => boolean} isPlaced    node still sits where insert() put it
 * @property {(node: Element) => void} remove
 * @property {(node: Element) => boolean} isConnected
 * @property {(node: Element) => boolean} isShown              on screen: not in a hidden subtree (display none, a hidden React Activity)
 * @property {() => boolean} pageHidden                        the page is not visible (its window in the background, occluded or minimized)
 * @property {(cb: () => void) => () => void} observeTree        any element added or removed anywhere; returns disconnect
 * @property {(cb: () => void) => () => void} observeRoot        <html> attribute changes (theme); returns disconnect
 * @property {(name: string) => string} cssVar                   computed value of a custom property on <html> ('' if unset)
 * @property {() => string[]} customProperties                    every custom property <html> computes (or the style sheets declare)
 * @property {() => 'light'|'dark'|null} rootTheme               from data-theme / class on <html>
 * @property {() => boolean} prefersDark
 * @property {(cb: () => void) => () => void} onPrefersChange
 * @property {(cb: (e: KeyboardEvent) => void) => () => void} onKey   capture-phase keydown on window
 * @property {() => { search: string, href: string }} location
 * @property {(fn: () => void, ms: number) => () => void} schedule
 * @property {() => boolean} isMac
 * @property {(target: unknown) => boolean} isEditable
 * @property {() => Element} body
 * @property {(css: string, id: string) => () => void} addStyle   inject a <style>; returns remover
 * @property {(el: Element, text: string) => boolean} setText
 * @property {(el: Element) => void} focus
 * @property {(text: string) => boolean} insertText   insert at the caret of the focused editable (execCommand)
 * @property {(el: Element) => void} click
 * @property {(el: Element, name: string) => string | null} attr
 * @property {(el: Element) => number} width                     its laid-out width in CSS pixels (0 when it has none)
 * @property {(el: Element) => number} height                    its laid-out height
 * @property {(value: string) => string} escapeAttr   escape for use inside a double-quoted attribute selector
 */

/** @param {Window & typeof globalThis} win */
export function createDom(win) {
  const doc = win.document;
  // The preload may inject us while the document is still loading (documentElement, head and body can be null): every accessor
  // below tolerates that, and the runtime defers construction until it exists (runtime.mjs whenDocumentReady).
  const root = () => doc.documentElement ?? null;
  return {
    query: (s) => doc.querySelector(s),
    queryAll: (s) => Array.from(doc.querySelectorAll(s)),
    createElement(tag, attrs = {}) {
      const el = doc.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      return el;
    },
    insert(anchorEl, node, position) {
      if (position === 'prepend') anchorEl.insertBefore(node, anchorEl.firstChild);
      else if (position === 'before') anchorEl.parentNode.insertBefore(node, anchorEl);
      else if (position === 'after') anchorEl.parentNode.insertBefore(node, anchorEl.nextSibling);
      else anchorEl.appendChild(node);
    },
    isPlaced(position, node, anchorEl) {
      if (!node.parentNode) return false;
      if (position === 'before') return node.nextSibling === anchorEl;
      if (position === 'after') return node.previousSibling === anchorEl;
      if (position === 'prepend') return node.parentNode === anchorEl && anchorEl.firstChild === node;
      return node.parentNode === anchorEl;
    },
    remove(node) { node.parentNode?.removeChild(node); },
    isConnected: (node) => node.isConnected === true,
    isShown: (node) => (typeof node.checkVisibility === 'function' ? node.checkVisibility() : typeof node.getClientRects === 'function' ? node.getClientRects().length > 0 : true),
    pageHidden: () => win.document?.visibilityState === 'hidden',
    observeTree(cb) {
      const mo = new win.MutationObserver(() => cb());
      // childList: anchors appear and vanish with their elements; watching every attribute of a streaming chat UI is costly.
      // The one attribute watched is `aria-current`: the app marks the active entry of a navigation with it (Settings: which page is open), and an
      // anchor can be gated on it (settings.section exists on the General page only), so a page change that only flips the attribute must reconcile too.
      // (The probe's periodic re-check is the safety net for other attribute-driven changes.)
      mo.observe(doc, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-current'] });
      return () => mo.disconnect();
    },
    observeRoot(cb) {
      const r = root();
      const mo = new win.MutationObserver(() => cb());
      if (r) mo.observe(r, { attributes: true }); else mo.observe(doc, { childList: true });   // no <html> yet: wake up when it appears
      return () => mo.disconnect();
    },
    customProperties() {
      const r = root();
      if (!r) return [];
      const out = new Set();
      const cs = win.getComputedStyle(r);
      for (let i = 0; i < (cs.length ?? 0); i++) { const n = cs[i]; if (typeof n === 'string' && n.startsWith('--')) out.add(n); }
      if (!out.size) {   // an engine whose computed style does not list them: the style sheets' declarations
        const walk = (rules) => { for (const rule of rules ?? []) { const st = rule.style; for (let i = 0; i < (st?.length ?? 0); i++) { const n = st[i]; if (typeof n === 'string' && n.startsWith('--')) out.add(n); } if (rule.cssRules) walk(rule.cssRules); } };
        for (const sheet of doc.styleSheets ?? []) { try { walk(sheet.cssRules); } catch { /* another origin's sheet */ } }
      }
      return [...out];
    },
    cssVar(name) {
      const r = root();
      if (!r) return '';
      const v = win.getComputedStyle(r).getPropertyValue(name);
      return typeof v === 'string' ? v.trim() : '';
    },
    rootTheme() {
      const r = root();
      if (!r) return null;
      const t = r.getAttribute('data-theme');
      if (t === 'dark' || t === 'light') return t;
      const cls = r.getAttribute('class') ?? '';
      if (/(^|\s)(dark|electron-dark)(\s|$)/.test(cls)) return 'dark';
      if (/(^|\s)(light|electron-light)(\s|$)/.test(cls)) return 'light';
      return null;
    },
    prefersDark: () => !!win.matchMedia?.('(prefers-color-scheme: dark)').matches,
    onPrefersChange(cb) {
      const mq = win.matchMedia?.('(prefers-color-scheme: dark)');
      if (!mq?.addEventListener) return () => {};
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    onKey(cb) {
      win.addEventListener('keydown', cb, true);
      return () => win.removeEventListener('keydown', cb, true);
    },
    location: () => ({ search: win.location.search, href: win.location.href }),
    schedule(fn, ms) {
      const h = win.setTimeout(fn, ms);
      return () => win.clearTimeout(h);
    },
    isMac: () => /Mac/i.test(win.navigator?.platform ?? ''),
    isEditable(t) {
      if (!t || typeof t !== 'object') return false;
      const tag = String(t.tagName ?? '').toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable === true;
    },
    body: () => doc.body ?? doc.documentElement,
    addStyle(css, id) {
      const el = doc.createElement('style');
      el.setAttribute('data-codexmods-style', id);
      el.textContent = css;
      const parent = doc.head ?? doc.documentElement;
      if (!parent) return () => {};
      parent.appendChild(el);
      return () => el.parentNode?.removeChild(el);
    },
    setText(el, text) { el.textContent = text; return true; },
    focus(el) { el.focus?.(); },
    insertText(text) { return typeof doc.execCommand === 'function' ? doc.execCommand('insertText', false, text) === true : false; },
    click(el) { el.click(); },
    attr: (el, name) => el.getAttribute(name),
    width: (el) => (typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect().width : 0),
    height: (el) => (typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect().height : 0),
    escapeAttr: (v) => String(v).replace(/["\\\n\r]/g, (c) => (c === '\n' ? '\\a ' : c === '\r' ? '\\d ' : `\\${c}`)),
  };
}
