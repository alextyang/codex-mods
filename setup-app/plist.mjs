// XML property lists, read and written without loss (the setup app's Dock step): `defaults export` gives one, `defaults import` takes it
// back. A value is { t, v }: a dict's v is its [key, value] pairs in order, an array's its values, a string's its text; an integer, real,
// date or data keeps its text as it was, so whatever the setup app does not change goes back byte for byte in meaning. Node built-ins only.

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => (e[0] === '#'
  ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()]));
const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The value of a plist's XML text. Throws on anything that is not a well-formed property list. */
export function parsePlist(xml) {
  const text = String(xml);
  const tags = /<(\/?)([A-Za-z]+)([^>]*?)(\/?)>|<\?[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>/g;
  let m;
  const next = () => {
    for (;;) {
      const at = tags.lastIndex;
      m = tags.exec(text);
      if (!m) throw new Error('plist: ended early');
      if (m[2]) return { close: m[1] === '/', name: m[2], empty: m[4] === '/', start: m.index, end: tags.lastIndex, gap: text.slice(at, m.index) };
    }
  };
  const textUntil = (name) => {
    const from = tags.lastIndex;
    const close = text.indexOf(`</${name}>`, from);
    if (close < 0) throw new Error(`plist: <${name}> not closed`);
    tags.lastIndex = close + name.length + 3;
    return text.slice(from, close);
  };
  const value = (tag) => {
    if (tag.close) throw new Error(`plist: unexpected </${tag.name}>`);
    const { name, empty } = tag;
    if (name === 'true' || name === 'false') return { t: name };
    if (name === 'dict') {
      const v = [];
      if (empty) return { t: 'dict', v };
      for (;;) {
        const k = next();
        if (k.close && k.name === 'dict') return { t: 'dict', v };
        if (k.name !== 'key' || k.close) throw new Error('plist: a dict needs a key');
        const key = k.empty ? '' : unescape(textUntil('key'));
        v.push([key, value(next())]);
      }
    }
    if (name === 'array') {
      const v = [];
      if (empty) return { t: 'array', v };
      for (;;) {
        const x = next();
        if (x.close && x.name === 'array') return { t: 'array', v };
        v.push(value(x));
      }
    }
    if (['string', 'integer', 'real', 'date', 'data'].includes(name)) {
      const raw = empty ? '' : textUntil(name);
      return { t: name, v: name === 'string' ? unescape(raw) : raw };
    }
    throw new Error(`plist: <${name}> is not a plist value`);
  };
  let top = next();
  if (top.name !== 'plist' || top.close) throw new Error('plist: no <plist>');
  top = next();
  const root = value(top);
  const end = next();
  if (!(end.close && end.name === 'plist')) throw new Error('plist: more than one value');
  return root;
}

/** The XML text of a plist value. */
export function writePlist(root) {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">', '<plist version="1.0">'];
  const put = (x, d) => {
    const pad = '\t'.repeat(d);
    switch (x.t) {
      case 'dict':
        if (!x.v.length) { out.push(`${pad}<dict/>`); return; }
        out.push(`${pad}<dict>`);
        for (const [k, v] of x.v) { out.push(`${pad}\t<key>${escape(k)}</key>`); put(v, d + 1); }
        out.push(`${pad}</dict>`);
        return;
      case 'array':
        if (!x.v.length) { out.push(`${pad}<array/>`); return; }
        out.push(`${pad}<array>`);
        for (const v of x.v) put(v, d + 1);
        out.push(`${pad}</array>`);
        return;
      case 'true': case 'false': out.push(`${pad}<${x.t}/>`); return;
      case 'string': out.push(`${pad}<string>${escape(x.v)}</string>`); return;
      case 'integer': case 'real': case 'date': case 'data': out.push(`${pad}<${x.t}>${x.v}</${x.t}>`); return;
      default: throw new Error(`plist: cannot write a ${x.t}`);
    }
  };
  put(root, 0);
  out.push('</plist>', '');
  return out.join('\n');
}

/** A dict's value at `key`, or undefined. */
export const get = (dict, key) => (dict?.t === 'dict' ? dict.v.find(([k]) => k === key)?.[1] : undefined);
/** Sets (or adds, at the end) a dict's `key`. */
export function set(dict, key, value) {
  const at = dict.v.findIndex(([k]) => k === key);
  if (at >= 0) dict.v[at] = [key, value]; else dict.v.push([key, value]);
}
/** Removes a dict's `key`, if it has one. */
export function remove(dict, key) { dict.v = dict.v.filter(([k]) => k !== key); }
/** A deep copy of a value. */
export const clone = (x) => JSON.parse(JSON.stringify(x));
