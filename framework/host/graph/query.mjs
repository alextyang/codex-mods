// Query and search (docs/design/public-hooks.md §3.2; docs/graph/04 §2). `query` is a type's collection as a reader may read it: a
// `where`, words its instances' titles have, an order by paths, and pages (`limit`, `cursor`: the next page starts after the last row of
// this one, so a row that comes or goes between pages never repeats or skips another). `search` answers from the resident graph (the
// titles and subtitles of the searchable types) and from each provider's own search (the native thread search), whose content matches
// reach only a reader that may read that content. Node built-ins only.
import { CodexModsError } from '../../../sdk/errors.mjs';
import { compileWhere, readPath } from '../../shared/where.mjs';

export const QUERY_LIMIT = 50, QUERY_MAX = 500;
export const SEARCH_LIMIT = 20, SEARCH_MAX = 100;
const SEARCH_TIMEOUT_MS = 5000;
const QUERY_KEYS = new Set(['type', 'where', 'text', 'sort', 'limit', 'cursor']);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const invalid = (m) => new CodexModsError('Invalid', m);

/** The words of a text, lower case (at most 8). */
function wordsOf(text) {
  if (text === undefined) return null;
  if (typeof text !== 'string' || text.length > 200) throw invalid('text is at most 200 characters');
  const words = text.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  return words.length ? words : null;
}
const has = (s, words) => typeof s === 'string' && words.every((w) => s.toLowerCase().includes(w));
/** A path's value as a row's sort key: JSON's own values (text: its first 512 characters order it); absent, unknown and null as null (last
 *  in either direction). Bounded, so a page's cursor always fits what a query takes back. */
const KEY_TEXT = 512;
const keyOf = (v) => (v === undefined || v === null ? null : typeof v === 'object' ? JSON.stringify(v).slice(0, KEY_TEXT) : typeof v === 'string' ? v.slice(0, KEY_TEXT) : v);
const CURSOR_MAX = 65_536;   // 4 keys of 512 characters, each escaped to 6 in JSON at most, and a ref's key, as base64
const KIND = { number: 0, string: 1, boolean: 2 };
// text in a reader's order: case and accents aside, numbers within it by value ("chat 9" before "chat 10")
const TEXT = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
function compareKeys(a, b, desc) {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  const ka = KIND[typeof a] ?? 3, kb = KIND[typeof b] ?? 3;
  const c = ka !== kb ? ka - kb : typeof a === 'string' ? TEXT.compare(a, b) : a < b ? -1 : a > b ? 1 : 0;
  return desc ? -c : c;
}

/** @param {{ registry: object, store: object, providers: Map<string, object>, log: object }} o */
export function createQueries({ registry, store, providers, log }) {
  /**
   * A page of a type's instances (`{items, next?}`): those its `where` keeps and `readable(snapshot)` lets the reader see, with every word
   * of `text` in their title or subtitle, in `sort`'s order (then by ref), `limit` (50, at most 500) of them after `cursor`.
   */
  function query(q, attached, readable) {
    if (!isObj(q) || typeof q.type !== 'string') throw invalid('query takes {type, where?, text?, sort?, limit?, cursor?}');
    const extra = Object.keys(q).find((k) => !QUERY_KEYS.has(k));
    if (extra) throw invalid(`${extra} is not a field of a query`);
    if (!registry.has(q.type)) throw invalid(`unknown type ${q.type}`);
    if (q.where !== undefined && q.where !== null && !isObj(q.where)) throw invalid('where is a where (an object)');
    const words = wordsOf(q.text);
    const sort = q.sort === undefined ? [] : q.sort;
    if (!Array.isArray(sort) || sort.length > 4) throw invalid('sort is a list of at most 4 {by: path, dir?: "asc" | "desc"}');
    for (const k of sort) {
      if (!isObj(k) || typeof k.by !== 'string' || (k.dir !== undefined && k.dir !== 'asc' && k.dir !== 'desc')) throw invalid('sort is a list of {by: path, dir?: "asc" | "desc"}');
      try { compileWhere({ [k.by]: { $exists: true } }); } catch (e) { throw invalid(`sort: ${k.by}: ${e?.message ?? e}`); }
    }
    const limit = q.limit === undefined ? QUERY_LIMIT : q.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > QUERY_MAX) throw invalid(`limit is 1 to ${QUERY_MAX}`);
    let after = null;
    if (q.cursor !== undefined && q.cursor !== null) {
      try { after = typeof q.cursor === 'string' && q.cursor.length <= CURSOR_MAX ? JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')) : null; } catch { after = null; }
      if (!Array.isArray(after) || after.length !== sort.length + 1) throw invalid('cursor is the `next` of the same query');
    }
    const may = typeof readable === 'function' ? readable : () => true;
    const env = store.whereEnv(attached, readable);
    const rows = [];
    for (const s of store.list(q.type, q.where ?? undefined, attached, readable)) {
      if (s.gone || !may(s)) continue;
      if (words && !has(s.summary?.title, words) && !has(s.summary?.subtitle, words)) continue;
      rows.push({ s, t: [...sort.map((k) => keyOf(readPath(s, k.by, env))), store.key(s.ref)] });
    }
    // the sort's keys, then the ref's key exactly (two rows are never the same row)
    const cmp = (a, b) => {
      for (let i = 0; i < sort.length; i++) { const c = compareKeys(a[i], b[i], sort[i].dir === 'desc'); if (c) return c; }
      const x = a[sort.length], y = b[sort.length];
      return x < y ? -1 : x > y ? 1 : 0;
    };
    rows.sort((a, b) => cmp(a.t, b.t));
    const from = after ? rows.filter((r) => cmp(r.t, after) > 0) : rows;
    const page = from.slice(0, limit);
    const next = from.length > limit ? Buffer.from(JSON.stringify(page.at(-1).t), 'utf8').toString('base64url') : undefined;
    return Object.freeze({ items: page.map((r) => r.s), ...(next ? { next } : {}) });
  }

  /**
   * What matches a text among the searchable types (`opts.types`, each searchable; all of them by default): `[{ref, title, field,
   * snippet?}]`, at most `opts.limit` (20, at most 100). Titles first (one that starts with the text first), then subtitles, then what the
   * providers' own search finds in content: such a match reaches only a reader that `readsContent(itsContentType)`, and its snippet with it.
   * @param {{ readable?: (snap: object) => boolean, readsContent?: (typeId: string) => boolean }} reader
   */
  async function search(text, opts, reader = {}) {
    if (typeof text !== 'string' || !text.trim() || text.length > 200) throw invalid('search takes a text of 1 to 200 characters');
    const o = isObj(opts) ? opts : {};
    const extra = Object.keys(o).find((k) => k !== 'types' && k !== 'limit');
    if (extra) throw invalid(`${extra} is not an option of search`);
    const searchable = registry.ids().filter((id) => registry.get(id)?.searchable);
    let types = searchable;
    if (o.types !== undefined) {
      if (!Array.isArray(o.types) || !o.types.length || o.types.some((t) => typeof t !== 'string')) throw invalid('types is a list of type ids');
      for (const t of o.types) if (!registry.get(t)?.searchable) throw invalid(`${t} is not searchable`);
      types = o.types;
    }
    const limit = o.limit === undefined ? SEARCH_LIMIT : o.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_MAX) throw invalid(`limit is 1 to ${SEARCH_MAX}`);
    const may = typeof reader.readable === 'function' ? reader.readable : () => true;
    const words = wordsOf(text);
    const first = words[0];
    const hits = new Map();
    for (const t of types) {
      for (const s of store.list(t, undefined, undefined, reader.readable)) {
        const k = store.key(s.ref);
        if (s.gone || hits.has(k) || !may(s)) continue;
        const title = s.summary?.title;
        const score = has(title, words) ? (String(title).toLowerCase().startsWith(first) ? 0 : 1) : has(s.summary?.subtitle, words) ? 2 : null;
        if (score !== null) hits.set(k, { s, score, field: score < 2 ? 'title' : 'subtitle' });
      }
    }
    const out = new Map();
    for (const h of [...hits.values()].sort((a, b) => a.score - b.score || String(a.s.summary?.title ?? '').localeCompare(String(b.s.summary?.title ?? '')))) {
      out.set(store.key(h.s.ref), Object.freeze({ ref: h.s.ref, title: h.s.summary?.title ?? '', field: h.field }));
    }
    for (const p of providers.values()) {
      if (typeof p.search !== 'function' || out.size >= limit) continue;
      // a search in content is not even asked for a reader who may not read that content: what it finds would tell
      if (p.searchContent && reader.readsContent?.(p.searchContent) !== true) continue;
      let found;
      try {
        let timer;
        found = await Promise.race([Promise.resolve(p.search(text.trim(), { types, limit })),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('it did not answer in time')), SEARCH_TIMEOUT_MS); timer.unref?.(); })]).finally(() => clearTimeout(timer));
      } catch (e) { log.warn('a provider\'s search failed', { provider: p.id, message: String(e?.message ?? e) }); continue; }
      for (const f of Array.isArray(found) ? found : []) {
        const s = isObj(f?.ref) ? store.get(f.ref) : null;
        if (!s || s.gone || !may(s) || !types.some((t) => registry.isA(s.ref.type, t))) continue;
        const k = store.key(s.ref);
        if (out.has(k)) continue;
        // a match in content says what the content holds: only for a reader of it
        const content = typeof f.content === 'string' ? f.content : null;
        if (content && reader.readsContent?.(content) !== true) continue;
        out.set(k, Object.freeze({ ref: s.ref, title: s.summary?.title ?? '', field: content ? 'content' : typeof f.field === 'string' ? f.field : 'title',
          ...(content && typeof f.snippet === 'string' ? { snippet: f.snippet.slice(0, 400) } : {}) }));
      }
    }
    return [...out.values()].slice(0, limit);
  }

  return { query, search };
}
