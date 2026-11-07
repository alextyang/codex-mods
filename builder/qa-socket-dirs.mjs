// QA only (adapter NOTES N8): relocate main's fixed /tmp socket directories into the QA profile.
//
// Main listens for the app tools on /tmp/codex-app-tools/<uuid>.sock and for the in-app browser on /tmp/codex-browser-use/<uuid>.sock.
// A QA profile runs as another macOS user; when the owner's stock app made those directories first (mode 0755), the QA copy gets EACCES.
// The edit replaces each directory literal with an expression evaluated in main: <profileDir>/run/<name>, or, when a socket path there
// would not fit macOS sun_path, a short directory in the user's own $TMPDIR. Product (daily) copies never get this edit.

/** macOS sun_path is 104 bytes including the terminator; a socket name is a uuid (36) + ".sock" after a "/". */
export const MAX_SOCKET_PATH = 103;
export const SOCKET_NAME_BYTES = 1 + 36 + '.sock'.length;

/** The two directories. `literal` is the bare path; main writes it as one whole string literal (never a minified name). */
export const QA_SOCKET_DIRS = Object.freeze([
  Object.freeze({ id: 'app-tools', literal: '/tmp/codex-app-tools', short: 'a' }),
  Object.freeze({ id: 'browser-use', literal: '/tmp/codex-browser-use', short: 'b' }),
]);
/** The string literals a directory may be written as: a template literal (up to 21477) or a quoted string (22943's minifier). */
export const anchorsOf = (dir) => ['`', '"', "'"].map((q) => `${q}${dir.literal}${q}`);

/** Files searched for the literals: every JavaScript file of the main/worker build. */
export const QA_SOCKET_SCAN = /^\.vite\/build\/[^/]+\.js$/;

const count = (s, needle) => { let n = 0; for (let i = s.indexOf(needle); i >= 0; i = s.indexOf(needle, i + 1)) n += 1; return n; };

/**
 * The directory for one socket family, as the edited main computes it. Its source is injected into main (Function#toString), so it uses
 * only its arguments and globals; tests run the same function.
 * @param {{ root: string, profile?: string, name: string, short: string, tmpdir: string, path: typeof import('node:path'), hash: (s: string) => string }} a
 */
export function qaSocketDir({ root, profile, name, short, tmpdir, path, hash }) {
  const profileDir = path.join(root, 'profiles', profile || 'default');
  const fits = (dir) => Buffer.byteLength(dir) + 42 <= 103; // SOCKET_NAME_BYTES, MAX_SOCKET_PATH
  const primary = path.join(profileDir, 'run', name);
  if (fits(primary)) return primary;
  const fallback = path.join(tmpdir, `cm${hash(profileDir).slice(0, 6)}`, short);
  if (fits(fallback)) return fallback;
  throw new Error(`codexmods QA: no ${name} socket directory fits sun_path (${primary}; ${fallback})`);
}

/** The JavaScript expression that replaces one anchor. Root and profile resolve as the loader does (env first, then the baked root).
 * Self-contained: main is CommonJS, so `require` is in scope. */
export function qaSocketDirExpression(root, dir) {
  const fn = qaSocketDir.toString();
  return `((${fn})({root:process.env.CODEX_MODS_ROOT||${JSON.stringify(root)},profile:process.env.CODEX_MODS_PROFILE,name:${JSON.stringify(dir.id)},short:${JSON.stringify(dir.short)},`
    + 'tmpdir:require("node:os").tmpdir(),path:require("node:path"),hash:(s)=>require("node:crypto").createHash("sha256").update(s).digest("hex")}))';
}

/**
 * Apply the relocation to the scanned files. `files` maps asar paths to their current contents. Every literal must occur exactly once
 * across all files, and that once as a whole string literal: anything else (missing, repeated, not a whole literal) throws (code QA_SOCKET_ANCHOR).
 * @returns {{ edits: Map<string, Buffer>, report: { applied: true, root: string, sites: { id: string, file: string, offset: number }[] } }}
 */
export function applyQaSocketDirs(files, root) {
  const edits = new Map();
  const sites = [];
  const text = (p) => (edits.get(p) ?? files.get(p)).toString('utf8');
  for (const dir of QA_SOCKET_DIRS) {
    const hits = [];
    for (const p of files.keys()) {
      const s = text(p);
      const bare = count(s, dir.literal);
      if (bare) hits.push({ file: p, bare, anchored: anchorsOf(dir).reduce((n, a) => n + count(s, a), 0) });
    }
    const bare = hits.reduce((n, h) => n + h.bare, 0);
    const site = hits.find((h) => h.anchored === 1);
    if (bare !== 1 || !site) {
      throw Object.assign(new Error(`QA socket relocation: ${dir.literal} occurs ${bare} time(s), expected exactly once as a whole string literal `
        + `(${hits.map((h) => `${h.file}: ${h.bare} bare, ${h.anchored} anchored`).join('; ') || 'no file'})`), { code: 'QA_SOCKET_ANCHOR', details: { id: dir.id, hits } });
    }
    const s = text(site.file);
    const anchor = anchorsOf(dir).find((a) => s.includes(a));
    const offset = s.indexOf(anchor);
    edits.set(site.file, Buffer.from(s.slice(0, offset) + qaSocketDirExpression(root, dir) + s.slice(offset + anchor.length), 'utf8'));
    sites.push({ id: dir.id, file: site.file, offset });
  }
  return { edits, report: { applied: true, root, sites } };
}
