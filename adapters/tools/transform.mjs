// Applies adapter SeamTransforms to file text exactly as the builder must (contracts/adapter.d.ts SeamTransform):
// exact-input (sha256Before of the whole file), `find` occurs exactly once, exact-output (sha256After).
import { createHash } from 'node:crypto';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function occurrences(text, find) {
  let n = 0;
  for (let i = text.indexOf(find); i >= 0; i = text.indexOf(find, i + find.length)) n++;
  return n;
}

/** Apply one transform to a file's text. Throws on any mismatch. Does not check hashes (see applyAll). */
export function applyOp(text, t) {
  const n = occurrences(text, t.find);
  if (n !== 1) throw new Error(`transform ${t.id}: find occurs ${n} times in ${t.file}, expected exactly 1`);
  const i = text.indexOf(t.find);
  switch (t.op) {
    case 'replace-once': return text.slice(0, i) + t.text + text.slice(i + t.find.length);
    case 'insert-before-once': return text.slice(0, i) + t.text + text.slice(i);
    case 'insert-after-once': return text.slice(0, i + t.find.length) + t.text + text.slice(i + t.find.length);
    default: throw new Error(`transform ${t.id}: unknown op ${t.op}`);
  }
}

/**
 * Apply transforms in array order. `readFile(path) → string` returns stock text.
 * Verifies sha256Before against the file's current text (stock for the first transform on a file, previous output after)
 * and sha256After against the result. Returns Map<path, text>.
 */
export function applyAll(transforms, readFile) {
  const files = new Map();
  for (const t of transforms) {
    const before = files.has(t.file) ? files.get(t.file) : readFile(t.file);
    if (sha256(before) !== t.sha256Before) throw new Error(`transform ${t.id}: sha256Before mismatch for ${t.file}`);
    const after = applyOp(before, t);
    if (sha256(after) !== t.sha256After) throw new Error(`transform ${t.id}: sha256After mismatch for ${t.file}`);
    files.set(t.file, after);
  }
  return files;
}

/** Fill sha256Before/After for a list of {id, seam, file, op, find, text}, chaining per-file. */
export function sealTransforms(drafts, readFile) {
  const files = new Map();
  return drafts.map((d) => {
    const before = files.has(d.file) ? files.get(d.file) : readFile(d.file);
    const after = applyOp(before, d);
    files.set(d.file, after);
    return { id: d.id, seam: d.seam, file: d.file, sha256Before: sha256(before), sha256After: sha256(after), op: d.op, find: d.find, text: d.text };
  });
}

// ---------------------------------------------------------------------------------------------- build files by role
// The bundler puts a content hash in every chunk name (`main-CqEoQDOU.js`, `src-DsLVGakC.js`, `app-initial-6350d04672d0.js`), so a name is
// never stable across builds. Edit ids and file lookups use the ROLE instead: the name without its hash (`main`, `src`, `worker`).

/**
 * The name of a build file without directory, content hash and extension: `.vite/build/main-CLu1A25j.js` -> `main`, `worker.js` -> `worker`,
 * `app-initial-dddef47d6ef6.js` -> `app-initial`, and 22943's numbered main-process chunks `early-bootstrap-916-2f6483d5bfd826f1.js` ->
 * `early-bootstrap-916`, and an rspack renderer chunk `assets/async/182735.d1916dd704.js` -> `182735`. A hash is 8 base64url characters (Vite) or 12 or 16 hex digits (the webview's, and 22943's main process), so a
 * hyphenated name (`browser-page-preload.js`) stays whole.
 */
export function fileStem(file) {
  const base = String(file).split('/').pop();
  const rspack = /^(\d+)\.[0-9a-f]{10}\.js$/.exec(base);   // an rspack renderer chunk (25679 on): `<chunk id>.<hash>.js`
  if (rspack) return rspack[1];
  const hashed = /^(.+)-(?:[A-Za-z0-9_-]{8}|[0-9a-f]{12}|[0-9a-f]{16})\.[cm]?js$/.exec(base);
  return hashed ? hashed[1] : base.replace(/\.[^.]+$/, '');
}

/** Hash-free form of an edit id: `cua-bundle-id:main-CqEoQDOU.js:1` -> `cua-bundle-id:main:1` (older packs embedded the chunk name). Other ids are returned as they are. */
export function normalizeEditId(id) {
  return String(id).replace(/^(cua-bundle-id:)(.+):(\d+)$/, (_, prefix, file, n) => `${prefix}${fileStem(file)}:${n}`);
}

/** Asar transforms whose id starts with one of these are mandatory isolation edits (ARCHITECTURE §5.3); every binary patch is one too. */
export const MANDATORY_TRANSFORM_PREFIXES = Object.freeze(['cua-', 'managed-config-']);
export const isMandatoryTransformId = (id) => MANDATORY_TRANSFORM_PREFIXES.some((p) => String(id).startsWith(p));

/**
 * The app's main-process bundles: `.vite/build/main-<hash>.js` (one bundle up to 21477), or 22943's `early-bootstrap.js` and its numbered
 * chunks `early-bootstrap-<n>-<hash>.js` (the main process split by the bundler). A role is found among these by its anchors, never by name.
 */
export const isMainBundle = (file) => /^\.vite\/build\/(?:main-[^/]+|early-bootstrap(?:-[^/]+)?)\.js$/.test(file);

/**
 * The one main-process bundle that contains every anchor string. Returns `{ file, text }`, or `{ error }` saying how many bundles matched
 * (none or several is an error: a role resolves to exactly one file).
 */
export function findMainBundle(source, anchors) {
  const hits = source.list('.vite/build/').filter(isMainBundle).map((file) => ({ file, text: source.read(file) })).filter((c) => anchors.every((a) => c.text.includes(a)));
  return hits.length === 1 ? hits[0] : { error: `${hits.length} main bundles (.vite/build/main-*.js or early-bootstrap*.js) contain ${anchors.map((a) => `"${a}"`).join(' and ')}, expected exactly 1` };
}
