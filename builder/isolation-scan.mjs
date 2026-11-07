// Content-based isolation scan (ARCHITECTURE v1.15): after every transform and patch, and before signing, no file of the bundled Computer Use
// tree or of the app's main/src/worker bundles may still carry the STOCK helper identity. Pack declarations cannot satisfy this; the bytes must.
import fs from 'node:fs';
import path from 'node:path';

/** Stock tokens. The renamed forms differ in the last character (…CUAServicf, SKY_CUA_SERVICE_PATM), so they never contain these. */
export const BARE_ID = 'com.openai.sky.CUAService';
export const GROUP_PREFIX = '2DC432GLL2.';
export const ENV_NAME = 'SKY_CUA_SERVICE_PATH';
export const ENCODINGS = Object.freeze(['utf8', 'utf16le']);
/** The copy's renamed container under OpenAI's team prefix: what ad-hoc builds keep, and what a team build must rewrite to <TEAM>.… */
export const OLD_GROUP = '2DC432GLL2.com.openai.sky.CUAServicf';
export const TEAM_RE = /^[A-Z0-9]{10}$/;

/**
 * Reviewed occurrences that are provably inert. Each entry: {file (relative to Contents/ or an asar path), kind?, reason}. Keep empty unless
 * a hit is shown to be unreachable at runtime; the reason is part of the review record and of build-report.json.
 */
const SKY = 'Resources/cua_node/lib/node_modules/@oai/sky';
const BAZEL_WHY = 'Bazel build metadata shipped inside the helper bundle (APP_BUNDLE_IDENTIFIER / APP_GROUP_ID build variables). Nothing loads it at runtime: no script in Resources/cua_node references BUILD.bazel, the only mentions are in the bundle\'s _CodeSignature/CodeResources manifest, which the uniform re-signing regenerates.';
export const ISOLATION_SCAN_ALLOWLIST = Object.freeze([
  { file: `${SKY}/Codex Computer Use.app/Contents/Resources/BUILD.bazel`, reason: BAZEL_WHY },
  { file: `${SKY}/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/Resources/BUILD.bazel`, reason: BAZEL_WHY },
  { file: `${SKY}/dist/project/cua/sky_js/scripts/install-computer-use-package.d.ts`, kind: 'env-name',
    reason: 'TypeScript declaration only (`export const …_ENV_VAR = "SKY_CUA_SERVICE_PATH"`). The scripts directory ships no install-computer-use-package.js, so there is nothing that could read or execute it; the runtime client (native-pipe.js) is patched to SKY_CUA_SERVICE_PATM.' },
]);

/**
 * Asar bundles that carry the helper client wiring: the main-process bundles (`main`, `src` up to 21477; 22943's `early-bootstrap.js` and
 * its numbered chunks, which hold nearly every site) and the workers.
 */
export const ASAR_SCAN_PATTERN = /^\.vite\/build\/(?:main|src|worker|early-bootstrap)(?:-[^/]*)?\.js$/;

/** Byte ranges of every code-signature blob of a (possibly fat) Mach-O; [] for anything else. The signature is replaced by the re-signing. */
export function signatureRanges(buf) {
  const ranges = [];
  try {
    const slices = [];
    if (buf.readUInt32BE(0) === 0xcafebabe) { const n = buf.readUInt32BE(4); for (let i = 0; i < n; i++) slices.push(buf.readUInt32BE(16 + i * 20)); } else slices.push(0);
    for (const base of slices) {
      if (buf.readUInt32LE(base) !== 0xfeedfacf) continue;
      const n = buf.readUInt32LE(base + 16); let p = base + 32;
      for (let i = 0; i < n; i++) { const c = buf.readUInt32LE(p), s = buf.readUInt32LE(p + 4); if (c === 0x1d) { const o = base + buf.readUInt32LE(p + 8); ranges.push([o, o + buf.readUInt32LE(p + 12)]); } p += s; }
    }
  } catch { /* not a Mach-O */ }
  return ranges;
}

const enc = (s, e) => Buffer.from(s, e);
const printable = (b) => b.toString('latin1').replace(/\0/g, '').replace(/[^\x20-\x7e]/g, '.');

/**
 * @returns {{hits: {file: string, offset: number, encoding: string, kind: 'group-id'|'bundle-id'|'env-name', context: string}[], signatureSkipped: number}}
 * Boundary: a bare id followed by exactly `f` is not stock (the rename produced it); anything else, including ".guardian", is a hit.
 */
export function scanBuffer(buf, { file = '?', ranges = signatureRanges(buf), forbidOldGroup = false } = {}) {
  const hits = []; let signatureSkipped = 0;
  const inSignature = (o) => ranges.some(([a, b]) => o >= a && o < b);
  for (const e of ENCODINGS) {
    const w = e === 'utf8' ? 1 : 2;
    const record = (offset, kind, len) => {
      if (inSignature(offset)) { signatureSkipped += 1; return; }
      hits.push({ file, offset, encoding: e, kind, context: printable(buf.subarray(Math.max(0, offset - 12 * w), Math.min(buf.length, offset + len + 24 * w))) });
    };
    const bare = enc(BARE_ID, e); const prefix = enc(GROUP_PREFIX, e);
    for (let i = buf.indexOf(bare); i >= 0; i = buf.indexOf(bare, i + 1)) {
      const at = i + bare.length;
      const next = e === 'utf8' ? buf[at] : (buf[at + 1] === 0 ? buf[at] : -1);
      if (next === 0x66) continue; // 'f': the renamed form
      const grouped = i >= prefix.length && buf.subarray(i - prefix.length, i).equals(prefix);
      record(grouped ? i - prefix.length : i, grouped ? 'group-id' : 'bundle-id', bare.length + (grouped ? prefix.length : 0));
    }
    if (forbidOldGroup) {
      const old = enc(OLD_GROUP, e);
      for (let i = buf.indexOf(old); i >= 0; i = buf.indexOf(old, i + 1)) record(i, 'unrewritten-group', old.length);
    }
    const env = enc(ENV_NAME, e);
    for (let i = buf.indexOf(env); i >= 0; i = buf.indexOf(env, i + 1)) record(i, 'env-name', env.length);
  }
  return { hits, signatureSkipped };
}

function* walkFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) yield* walkFiles(p); else if (e.isFile()) yield p;
  }
}

/**
 * Scan the Computer Use tree and the given asar bundles.
 * @param {string} contents the copy's Contents/
 * @param {{path: string, buf: Buffer}[]} asarFiles final contents of the asar bundles to scan
 * @param {{subtree?: string, allowlist?: readonly {file: string, kind?: string, reason: string}[]}} [o]
 */
export function isolationScan(contents, asarFiles = [], { subtree = 'Resources/cua_node', allowlist = ISOLATION_SCAN_ALLOWLIST, forbidOldGroup = false } = {}) {
  const found = []; let files = 0; let signatureSkipped = 0;
  const take = (name, buf) => {
    files += 1;
    const r = scanBuffer(buf, { file: name, forbidOldGroup });
    signatureSkipped += r.signatureSkipped;
    found.push(...r.hits);
  };
  const base = path.join(contents, subtree);
  if (fs.existsSync(base)) for (const f of walkFiles(base)) take(path.relative(contents, f), fs.readFileSync(f));
  for (const a of asarFiles) take(`app.asar:${a.path}`, a.buf);
  const allowed = []; const hits = [];
  for (const h of found) {
    const rule = allowlist.find((x) => (x.file === h.file || x.file === h.file.replace(/^app\.asar:/, '')) && (!x.kind || x.kind === h.kind));
    if (rule) allowed.push({ ...h, reason: rule.reason }); else hits.push(h);
  }
  return { files, hits, allowlisted: allowed, signatureSkipped };
}

/** Scan free text (for example the JSON of a signed entitlement set) for the stock tokens. */
export function scanText(text, file, { forbidOldGroup = false } = {}) {
  return scanBuffer(Buffer.from(text, 'utf8'), { file, ranges: [], forbidOldGroup }).hits;
}

/**
 * Same-length rewrite of the container's team prefix in a buffer (UTF-8 and UTF-16LE), outside Mach-O signature blobs.
 * @returns {{buf: Buffer, count: number}} `buf` is the input itself when nothing matched
 */
export function rewriteGroupBuffer(buf, team, { ranges = signatureRanges(buf) } = {}) {
  if (!TEAM_RE.test(team)) throw new Error(`invalid team id ${JSON.stringify(team)}`);
  let out = null; let count = 0;
  const inSignature = (o) => ranges.some(([a, b]) => o >= a && o < b);
  for (const e of ENCODINGS) {
    const old = enc(OLD_GROUP, e);
    const prefixLen = enc(OLD_GROUP.slice(0, 10), e).length;
    const replacement = enc(team, e);
    for (let i = buf.indexOf(old); i >= 0; i = buf.indexOf(old, i + 1)) {
      if (inSignature(i)) continue;
      out ??= Buffer.from(buf);
      replacement.copy(out, i); count += 1;
      if (replacement.length !== prefixLen) throw new Error('team rewrite must keep the length');
    }
  }
  return { buf: out ?? buf, count };
}

/**
 * Rewrite the container group id in every file of the Computer Use tree (in place, through a new inode, keeping the mode) and in the given
 * asar bundles (returned for the caller to store). Same length everywhere.
 * @returns {{sites: {file: string, count: number}[], total: number, asar: Map<string, Buffer>}}
 */
export function rewriteTeamGroup(contents, asarFiles, team, { subtree = 'Resources/cua_node' } = {}) {
  const sites = []; const asar = new Map(); let total = 0;
  const base = path.join(contents, subtree);
  if (fs.existsSync(base)) {
    for (const f of walkFiles(base)) {
      const buf = fs.readFileSync(f);
      const r = rewriteGroupBuffer(buf, team);
      if (!r.count) continue;
      const mode = fs.statSync(f).mode & 0o7777;
      const tmp = `${f}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, r.buf, { mode }); fs.renameSync(tmp, f);
      sites.push({ file: path.relative(contents, f), count: r.count }); total += r.count;
    }
  }
  for (const a of asarFiles) {
    const r = rewriteGroupBuffer(a.buf, team);
    if (!r.count) continue;
    asar.set(a.path, r.buf); sites.push({ file: `app.asar:${a.path}`, count: r.count }); total += r.count;
  }
  return { sites, total, asar };
}

/** OpenAI's Team ID. The Computer Use helper pins its clients (and its own parent) by this bare id: client names next to team ids in the service, a code requirement plist, ... */
export const STOCK_TEAM = '2DC432GLL2';

/**
 * Same-length rewrite of every bare stock team id (UTF-8 and UTF-16LE) outside Mach-O signature blobs. Other team ids are left alone.
 * @returns {{buf: Buffer, count: number}} `buf` is the input itself when nothing matched
 */
export function rewriteBareTeamBuffer(buf, team, { ranges = signatureRanges(buf) } = {}) {
  if (!TEAM_RE.test(team)) throw new Error(`invalid team id ${JSON.stringify(team)}`);
  let out = null; let count = 0;
  const inSignature = (o) => ranges.some(([a, b]) => o >= a && o < b);
  for (const e of ENCODINGS) {
    const old = enc(STOCK_TEAM, e); const replacement = enc(team, e);
    if (replacement.length !== old.length) throw new Error('team rewrite must keep the length');
    for (let i = buf.indexOf(old); i >= 0; i = buf.indexOf(old, i + 1)) {
      if (inSignature(i)) continue;
      out ??= Buffer.from(buf);
      replacement.copy(out, i); count += 1;
    }
  }
  return { buf: out ?? buf, count };
}

/** Rewrite the bare stock team id in EVERY file under Contents/<subtree> only (never outside it), in place through a new inode keeping the mode. */
export function rewriteComputerUseTeam(contents, team, { subtree = 'Resources/cua_node' } = {}) {
  const sites = []; let total = 0;
  const base = path.join(contents, subtree);
  if (fs.existsSync(base)) {
    for (const f of walkFiles(base)) {
      const r = rewriteBareTeamBuffer(fs.readFileSync(f), team);
      if (!r.count) continue;
      const mode = fs.statSync(f).mode & 0o7777;
      const tmp = `${f}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, r.buf, { mode }); fs.renameSync(tmp, f);
      sites.push({ file: path.relative(contents, f), count: r.count }); total += r.count;
    }
  }
  return { team, sites, total };
}

/**
 * The one native addon OUTSIDE the Computer Use tree (Resources/cua_node) that pins its socket peers — main's app-tools and in-app-browser
 * local sockets — by OpenAI's bare Team ID. Every other file under Resources/native carries the stock team id only inside its signature blob
 * (which the re-signing regenerates), so only this one needs the same-length rewrite the cua_node tree already gets.
 */
export const NATIVE_PEER_AUTH_FILE = 'Resources/native/browser-use-peer-authorization.node';

/** A refused native peer-authorization rewrite (the file is missing, or does not carry exactly one rewritable stock-team id). Carries a `.code` the builder maps to a BuildError. */
export class NativePeerAuthError extends Error {
  constructor(code, message, details) { super(message); this.name = 'NativePeerAuthError'; this.code = code; this.details = details; }
}

/**
 * Re-pin the native peer-authorization addon to the copy's team (adapter NOTES N9): the SAME same-length bare stock-team rewrite as the
 * Computer Use tree (rewriteComputerUseTeam), applied to the single file under Resources/native whose team pin gates main's app-tools and
 * in-app-browser sockets. Team builds only. Fail closed: the file must exist and carry EXACTLY ONE rewritable stock team id outside the Mach-O
 * signature blob (the re-signing replaces that blob) — zero (a stock drift that would silently no-op) or more than one is refused. Written in
 * place through a new inode, keeping the mode, like rewriteComputerUseTeam.
 * @returns {{file: string, count: number}}
 */
export function rewriteNativePeerAuthTeam(contents, team, { file = NATIVE_PEER_AUTH_FILE } = {}) {
  if (!TEAM_RE.test(team)) throw new Error(`invalid team id ${JSON.stringify(team)}`);
  const abs = path.join(contents, file);
  const st = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (!st?.isFile()) throw new NativePeerAuthError('NATIVE_PEER_AUTH_MISSING', `the native peer-authorization addon is missing from the copy: ${file}`, { file });
  const { buf, count } = rewriteBareTeamBuffer(fs.readFileSync(abs), team);
  if (count !== 1) throw new NativePeerAuthError('NATIVE_PEER_AUTH_DRIFT', `${file} must carry exactly one rewritable stock team id ${STOCK_TEAM} (outside the signature blob); found ${count}`, { file, count });
  const mode = st.mode & 0o7777;
  const tmp = `${abs}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, buf, { mode }); fs.renameSync(tmp, abs);
  return { file, count };
}

/**
 * Remaining bare stock team ids under Contents/<subtree> (outside signature blobs). Empty allowlist by default: every file of the tree is rewritten,
 * including the inert Bazel metadata, so nothing needs to be excused.
 */
export function stockTeamLeftovers(contents, { subtree = 'Resources/cua_node', allowlist = [] } = {}) {
  const hits = [];
  const base = path.join(contents, subtree);
  if (!fs.existsSync(base)) return hits;
  for (const f of walkFiles(base)) {
    const buf = fs.readFileSync(f); const ranges = signatureRanges(buf); const rel = path.relative(contents, f);
    if (allowlist.some((a) => a.file === rel)) continue;
    for (const e of ENCODINGS) {
      const tok = enc(STOCK_TEAM, e);
      for (let i = buf.indexOf(tok); i >= 0; i = buf.indexOf(tok, i + 1)) {
        if (ranges.some(([a, b]) => i >= a && i < b)) continue;
        hits.push({ file: rel, offset: i, encoding: e, kind: 'stock-team', context: printable(buf.subarray(Math.max(0, i - 12), Math.min(buf.length, i + 40))) });
      }
    }
  }
  return hits;
}

/** Payload of the privileged locked-use installer (ARCHITECTURE v1.16): removed from the copy; nothing named like it may remain in the CU tree. */
export const LOCKED_USE_PAYLOAD_NAMES = Object.freeze(['Codex Computer Use Installer.app', 'CodexComputerUseAuthorizationPlugin.bundle', 'CodexComputerUseAuthorizationPluginInstallerTool', 'CodexComputerUseAuthorizationPlugin']);
export const LOCKED_USE_LEFTOVER = /(AuthorizationPlugin|Installer)/;

/** Delete every payload entry anywhere under `contents`; returns the removed paths relative to it. */
export function removeLockedUsePayload(contents) {
  const removed = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) { if (LOCKED_USE_PAYLOAD_NAMES.includes(e.name)) { fs.rmSync(full, { force: true }); removed.push(path.relative(contents, full)); } continue; }
      if (LOCKED_USE_PAYLOAD_NAMES.includes(e.name)) { fs.rmSync(full, { recursive: true, force: true }); removed.push(path.relative(contents, full)); continue; }
      if (e.isDirectory()) walk(full);
    }
  })(contents);
  return removed.sort();
}

/** Anything under the CU tree still named like the installer payload. */
export function lockedUseLeftovers(contents, { subtree = 'Resources/cua_node' } = {}) {
  const out = [];
  const base = path.join(contents, subtree);
  if (!fs.existsSync(base)) return out;
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (LOCKED_USE_LEFTOVER.test(e.name)) out.push(path.relative(contents, full));
      if (e.isDirectory() && !e.isSymbolicLink()) walk(full);
    }
  })(base);
  return out;
}
