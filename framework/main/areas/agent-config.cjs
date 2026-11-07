'use strict';
// The Configuration page's six project keys: guard the app's roots, edit the same lines and save through its workspaceFiles service.
const fs = require('node:fs');
const path = require('node:path');
const kit = require('../area-kit.cjs');

function valid(key, value) {
  switch (key) {
    case 'approval_policy': return value === null || ['on-request', 'never'].includes(value);
    case 'sandbox_mode': return value === null || ['read-only', 'workspace-write', 'danger-full-access'].includes(value);
    case 'sandbox_workspace_write.network_access': return value === null || typeof value === 'boolean';
    case 'web_search': return value === null || ['disabled', 'cached', 'indexed', 'live'].includes(value);
    case 'model_verbosity': return value === null || ['low', 'medium', 'high'].includes(value);
    case 'model_reasoning_summary': return value === null || ['auto', 'concise', 'detailed', 'none'].includes(value);
    default: return false;
  }
}

function edit(text, key, value) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const table = (line) => /^\s*\[/.test(line);
  const firstTable = lines.findIndex(table);
  const topEnd = firstTable < 0 ? lines.length : firstTable;
  let start = 0, end = topEnd, name = key;
  if (key === 'sandbox_workspace_write.network_access') {
    if (lines.slice(0, topEnd).some((line) => /^\s*sandbox_workspace_write\s*=\s*\{/.test(line))) throw kit.refusal('the project config uses an inline sandbox_workspace_write table');
    const header = lines.findIndex((line) => /^\s*\[sandbox_workspace_write\]\s*(?:#.*)?$/.test(line));
    if (header < 0) return value === null ? text : `${text}${eol}[sandbox_workspace_write]${eol}network_access = ${value}${eol}`;
    start = header + 1;
    end = lines.findIndex((line, i) => i >= start && table(line));
    if (end < 0) end = lines.length;
    name = 'network_access';
  }
  const at = lines.findIndex((line, i) => i >= start && i < end && new RegExp(`^\\s*${name}\\s*=`).test(line));
  if (value === null) {
    if (at < 0) return text;
    lines.splice(at, 1);
  } else {
    const line = `${name} = ${typeof value === 'string' ? JSON.stringify(value) : value}`;
    if (at >= 0) lines[at] = line;
    else if (name === 'network_access') lines.splice(start, 0, line);
    else if (firstTable >= 0) lines.splice(firstTable, 0, line);
    else {
      if (lines.at(-1) === '') lines.splice(lines.length - 1, 0, line);
      else lines.push(line, '');
    }
  }
  return lines.join(eol);
}

// ------------------------------------------------------------------ a table's `enabled` (a tool server's, a plugin's: scoped enable, F9)
/**
 * A TOML document's statements, read in one pass (comments, the four kinds of strings, and arrays and inline tables across lines are
 * read as such, never as keys): each table header (`{kind: 'table' | 'array', path, start, end}`, `end` past its line's end) and each
 * key's assignment at a table's top level (`{kind: 'key', table, path, start, end, valueStart, valueEnd, value}`: `path` the key's own
 * parts, decoded; `value` the value's text when it is a bare word, else null). Null when the text is not TOML it can read.
 */
function statements(text) {
  const out = [];
  const n = text.length;
  let i = 0, table = [];
  const fail = () => { throw new SyntaxError('toml'); };
  const ws = () => { while (i < n && (text[i] === ' ' || text[i] === '\t')) i++; };
  const comment = () => { if (text[i] === '#') while (i < n && text[i] !== '\n') i++; };
  const newline = () => { if (text[i] === '\r' && text[i + 1] === '\n') { i += 2; return true; } if (text[i] === '\n') { i++; return true; } return false; };
  // the end of a statement's line: blanks, a comment, then a newline or the end
  const lineEnd = () => { ws(); comment(); if (i < n && !newline()) fail(); };
  const hex = (len) => { const h = text.slice(i, i + len); if (!/^[0-9A-Fa-f]+$/.test(h) || h.length !== len) fail(); i += len; const c = parseInt(h, 16); if (c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff)) fail(); return String.fromCodePoint(c); };
  const ESC = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
  /** A one-line "basic" string from its opening quote, decoded. */
  const basic = () => {
    let s = '';
    for (i++; ; ) {
      if (i >= n || text[i] === '\n' || text[i] === '\r') fail();
      const c = text[i++];
      if (c === '"') return s;
      if (c !== '\\') { s += c; continue; }
      const e = text[i++];
      if (e === 'u') s += hex(4); else if (e === 'U') s += hex(8); else if (Object.hasOwn(ESC, e)) s += ESC[e]; else fail();
    }
  };
  /** A one-line 'literal' string from its opening quote. */
  const literal = () => { const j = text.indexOf("'", i + 1); const nl = text.indexOf('\n', i + 1); if (j < 0 || (nl >= 0 && nl < j)) fail(); const s = text.slice(i + 1, j); i = j + 1; return s; };
  /** A multi-line string from its opening `"""` or `'''` (up to two more quotes before its close are its own). */
  const multi = (q) => {
    for (i += 3; ; ) {
      if (i >= n) fail();
      if (q === '"' && text[i] === '\\') { i += 2; continue; }
      if (text.startsWith(q.repeat(3), i)) { i += 3; let k = 0; while (k < 2 && text[i] === q) { i++; k++; } return; }
      i++;
    }
  };
  const key = () => {
    const parts = [];
    for (;;) {
      ws();
      if (text[i] === '"') parts.push(basic());
      else if (text[i] === "'") parts.push(literal());
      else { const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i, i + 256)); if (!m) fail(); parts.push(m[0]); i += m[0].length; }
      ws();
      if (text[i] !== '.') return parts;
      i++;
    }
  };
  // between an array's values: blanks, newlines and comments
  const gap = () => { for (;;) { ws(); comment(); if (!newline()) return; } };
  /** A value, skipped; its bare text when it is a bare word (a boolean, a number, a date), else null. */
  const value = (depth) => {
    if (depth > 100) fail();
    if (text.startsWith('"""', i)) { multi('"'); return null; }
    if (text.startsWith("'''", i)) { multi("'"); return null; }
    if (text[i] === '"') { basic(); return null; }
    if (text[i] === "'") { literal(); return null; }
    if (text[i] === '[') {
      i++;
      for (gap(); text[i] !== ']'; gap()) { if (i >= n) fail(); value(depth + 1); gap(); if (text[i] === ',') i++; else if (text[i] !== ']') fail(); }
      i++;
      return null;
    }
    if (text[i] === '{') {
      i++; ws();
      if (text[i] === '}') { i++; return null; }
      for (;;) { key(); if (text[i] !== '=') fail(); i++; ws(); value(depth + 1); ws(); if (text[i] === ',') { i++; ws(); continue; } if (text[i] === '}') { i++; return null; } fail(); }
    }
    const m = /^[^\s,\]}#]+(?:[ T][^\s,\]}#]+)?/.exec(text.slice(i, i + 128));
    if (!m) fail();
    i += m[0].length;
    return m[0];
  };
  try {
    if (text.charCodeAt(0) === 0xfeff) i = 1;
    for (;;) {
      gap();
      if (i >= n) return out;
      const start = i;
      if (text[i] === '[') {
        const array = text[i + 1] === '[';
        i += array ? 2 : 1;
        const path = key();
        if (array ? !text.startsWith(']]', i) : text[i] !== ']') fail();
        i += array ? 2 : 1;
        lineEnd();
        out.push({ kind: array ? 'array' : 'table', path, start, end: i });
        table = path;
        continue;
      }
      const path = key();
      if (text[i] !== '=') fail();
      i++; ws();
      const valueStart = i;
      const word = value(0);
      const valueEnd = i;
      lineEnd();
      out.push({ kind: 'key', table, path, start, end: i, valueStart, valueEnd, value: word });
    }
  } catch (e) {
    if (e instanceof SyntaxError) return null;
    throw e;
  }
}
const quoteKey = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k).replace(/\u007f/g, '\\u007F'));
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const startsWith = (a, b) => a.length >= b.length && b.every((x, i) => a[i] === x);
/** Where `[<table>.<name>]` and its `enabled` are in a document's statements; refused when the document says them another way. */
function locate(list, table, name) {
  const target = [table, name];
  let header = null, enabled = null, own = 0;
  for (const s of list) {
    if (s.kind === 'array' && (startsWith(s.path, target) || startsWith(target, s.path))) throw kit.refusal(`the project's config sets ${name} or its ${table} as an array of tables: edit it there`);
    if (s.kind === 'table' && same(s.path, target)) { if (header) throw kit.refusal(`the project's config has two [${table}.${name}] tables`); header = s; continue; }
    if (s.kind === 'table' && startsWith(s.path, [...target, 'enabled'])) throw kit.refusal(`the project's config sets ${name}'s enabled as a table: edit it there`);
    if (s.kind !== 'key') continue;
    const full = [...s.table, ...s.path];
    // the entry, or one of its parents, said by a value (an inline table, a dotted key) outside the entry's own table
    if (startsWith(full, target) && !startsWith(s.table, target)) throw kit.refusal(`the project's config sets ${name} with a dotted key or an inline table: edit it there`);
    if (startsWith(target, full)) throw kit.refusal(`the project's config sets ${full.join('.')} with an inline table: edit it there`);
    if (same(s.table, target)) {
      if (same(s.path, ['enabled'])) { if (enabled) throw kit.refusal(`the project's config sets ${name}'s enabled twice`); enabled = s; } else own++;
    }
    // `enabled` said as a table (a dotted key under it): a value cannot be added beside it
    if (full.length > target.length + 1 && startsWith(full, [...target, 'enabled'])) throw kit.refusal(`the project's config sets ${name}'s enabled as a table: edit it there`);
  }
  return { header, enabled, own };
}
/**
 * `text` (a project's .codex/config.toml) with `[<table>.<name>] enabled` set to `value` (true or false), or taken away (null: the table
 * too when nothing else is in it). Refused when the file is not TOML this can read, or says the entry another way (an inline table, a
 * dotted key, an array of tables) that an edit of its own lines cannot keep; the new text is read again before it is given.
 */
function setTableEnabled(text, table, name, value) {
  const list = statements(text);
  if (!list) throw kit.refusal('the project\'s config is not TOML that can be edited here: edit it there');
  const { header, enabled, own } = locate(list, table, name);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const line = `enabled = ${value}`;
  let out;
  if (!header) {
    if (value === null) return text;
    // an entry defined only by its subtables' headers gets its own header first (TOML allows a table after its subtables)
    const body = text.replace(/\s+$/, '');
    out = `${body}${body ? `${eol}${eol}` : ''}[${table}.${quoteKey(name)}]${eol}${line}${eol}`;
  } else if (value !== null) {
    // a header on the file's last line, with no line end after it, gets one first
    const lead = !enabled && header.end === text.length && !/\n$/.test(text) ? eol : '';
    out = enabled ? text.slice(0, enabled.start) + line + text.slice(enabled.valueEnd) : text.slice(0, header.end) + lead + line + eol + text.slice(header.end);
  } else {
    if (!enabled) return text;
    out = text.slice(0, enabled.start) + text.slice(enabled.end);
    // nothing else in the table (blanks only up to the next statement): the header goes too
    const next = list.find((s) => s.start > header.start && s !== enabled);
    const rest = out.slice(header.end, next ? next.start - (enabled.end - enabled.start) : out.length);
    if (!own && !rest.trim()) {
      out = out.slice(0, header.start) + out.slice(header.end + rest.length);
      // the last table gone: the blank lines it leaves at the end too
      if (!next) { const body = out.replace(/\s+$/, ''); out = body ? body + eol : ''; }
    }
  }
  // read again: what was written is TOML, with exactly the entry asked for
  const again = statements(out);
  const got = again ? locate(again, table, name) : null;
  const ok = got && (value === null ? !got.enabled : got.header && got.enabled?.value === String(value));
  if (!ok) throw kit.refusal('the project\'s config could not be edited here safely: edit it there');
  return out;
}

const queues = new Map();   // a config file (its real path) -> the tail of the framework's writes to it (one at a time)
function serially(file, fn) {
  const run = (queues.get(file) ?? Promise.resolve()).then(fn, fn);
  const tail = run.then(() => {}, () => {});
  queues.set(file, tail);
  void tail.then(() => { if (queues.get(file) === tail) queues.delete(file); });
  return run;
}
const missing = (e) => e?.code === 'ENOENT' || e?.code === 'ENOTDIR' || /^ENOENT\b/.test(String(e?.message));
/** A file's path as one queue knows it: its folder's real path (a symbolic link followed) when there is one, else as written. */
function realFile(file) {
  try { return path.join(fs.realpathSync.native(path.dirname(file)), path.basename(file)); } catch { return file; }
}
/**
 * Edit the `.codex/config.toml` of one of the app's projects (its root) the app's way: read through its workspaceFiles service, written
 * back whole only if it is still the file that was read (the service's conditional write with its read's etag: a write since, the
 * framework's or the user's, is a conflict, never knowingly overwritten; the service checks then writes, so a write between the two is
 * not seen); the framework's own writes to one file (by its real path) go one at a time. A missing `.codex` folder is made first, and
 * the write is still conditional (no file there). `edit(text)` gives the new text (the same: nothing written).
 */
async function writeProjectConfig(hooks, root, edit) {
  const projects = kit.globalState(hooks).get('local-projects');
  if (typeof root !== 'string' || !path.isAbsolute(root) || !Object.values(projects ?? {}).some((p) => Array.isArray(p?.rootPaths) && p.rootPaths.includes(root))) throw kit.refusal('the root is not one of the app\'s projects');
  const { svc } = kit.service(hooks, 'workspaceFiles', ['read', 'write']);
  const file = path.join(root, '.codex', 'config.toml');
  return serially(realFile(file), async () => {
    let text, etag;
    try {
      const r = await kit.withTimeout(svc.read({ hostId: 'local', path: file, representation: 'text', maxBytes: 1_048_576 }));
      text = typeof r?.text === 'string' ? r.text : '';
      etag = typeof r?.etag === 'string' && r.etag ? r.etag : null;
    } catch (e) {
      if (!missing(e)) throw e;
      text = ''; etag = 'missing';
    }
    const contents = edit(text);
    if (contents === text) return { written: false };
    if (etag === null) throw kit.refusal('the project\'s config has no version to write against: nothing was written');
    const write = () => kit.withTimeout(svc.write({ path: file, hostId: 'local', ifMatch: etag, bytes: Buffer.from(contents, 'utf8') }));
    let r;
    try {
      r = await write();
    } catch (e) {
      if (etag !== 'missing' || !missing(e)) throw e;
      // no .codex folder: made here, then the same conditional write (a file someone made since is a conflict)
      fs.mkdirSync(path.dirname(file), { recursive: true });
      r = await write();
    }
    if (r?.outcome === 'conflict') throw kit.refusal('the project\'s config changed since it was read: nothing was written');
    if (r?.outcome !== 'saved') throw kit.refusal(`the project's config was not written (${r?.outcome ?? 'no answer'})`);
    return { written: true };
  });
}
/**
 * A project's own `enabled` of a tool server or a plugin (`{root, name, value: true | false | null}`), as `table` names them. Written, the
 * windows' prewarmed new chats are dropped (the app reuses one for the next new chat without comparing these settings): new chats in the
 * project use it; chats already running keep what they started with.
 */
async function projectEnabled(hooks, table, args = {}) {
  const { root, name, value } = args;
  if (typeof name !== 'string' || !name || name.length > 256 || /[\r\n]/.test(name)) throw kit.refusal('a name is needed');
  if (value !== true && value !== false && value !== null) throw kit.refusal('enabled is true, false or null');
  const r = await writeProjectConfig(hooks, root, (text) => setTableEnabled(text, table, name, value));
  if (r.written) await kit.clearPrewarmed(hooks);
  return r;
}

function register(hooks) {
  hooks.onAreaOp('agent-config', async (op, args = {}) => {
    if (op === 'refresh') return { refreshed: await kit.invalidate(hooks, args.keys) };
    if (op !== 'project-config-write') throw kit.refusal(`unknown operation ${op}`);
    const { root, key, value } = args;
    if (!valid(key, value)) throw kit.refusal('the project config key or value is not supported');
    return writeProjectConfig(hooks, root, (text) => edit(text, key, value));
  });
}

module.exports = { register, setTableEnabled, projectEnabled };
