// Builder: stock ChatGPT.app -> launchable modded copy (ARCHITECTURE.md §5).
//
//   node builder/build.mjs --stock /Applications/ChatGPT.app --adapter <adapter.json> --loader <loader.cjs>
//        --relay <relay executable> --root <frameworkRoot> --identity <name|-> --out <dir> [--name "ChatGPT Mods"] [--force]
//        [--require-identity] (refuse ad-hoc "-", daily setup) [--allow-updater] (diagnostics only: tolerate incomplete updater suppression)
//        [--allow-no-isolation-baseline] (diagnostics only: skip the isolation baseline check)
//        [--qa-no-restore] (QA only: disable AppKit persistence before signing)
//        [--qa-socket-dirs] (QA only: main's /tmp socket directories under the profile, adapter NOTES N8)
//
// The copy is staged in <out>/.partial and moved to <out>/<name>.app only after signing and verification pass;
// <out>/build-report.json is written last and is the completeness marker. A failure removes the staging area.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { AsarArchive, writeAsar } from './asar.mjs';
import {
  dictionaryDigest, patchFrameworkDigest, readPlistJson, removePlistKey, rewritePlistIntegrity, setPlistBool, setPlistString,
} from './integrity.mjs';
import { applyQaSocketDirs, QA_SOCKET_SCAN } from './qa-socket-dirs.mjs';
import { signBundle, readTeamIdentifier, dumpSignedEntitlements, evaluateSignedGroups } from './sign.mjs';
import { isolationScan, ASAR_SCAN_PATTERN, OLD_GROUP, TEAM_RE, rewriteTeamGroup, rewriteComputerUseTeam, rewriteNativePeerAuthTeam, NativePeerAuthError, stockTeamLeftovers, STOCK_TEAM, removeLockedUsePayload, lockedUseLeftovers, scanText } from './isolation-scan.mjs';

export const BUNDLE_ID = 'dev.codexmods.app';
export const DEFAULT_USER_DATA_DIRECTORY_NAME = 'ChatGPT Mods';
export const DEFAULT_OWL_INI = 'Resources/owl-app.ini';
export const LOADER_NAME = 'codexmods-loader.cjs';
export const ASAR_REL = 'Resources/app.asar';
export const OVERRIDE_RELAY_REL = 'Resources/codexmods-relay';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
function sha256File(p) {
  const h = createHash('sha256');
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.alloc(4 * 1024 * 1024);
    for (let pos = 0; ;) { const n = fs.readSync(fd, buf, 0, buf.length, pos); if (!n) break; h.update(buf.subarray(0, n)); pos += n; }
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

/** First 16 hex of sha256 over the build inputs (contracts/layout.mjs `apps`). Recovery names candidates <build>-<inputsHash>. */
export function buildInputsHash({ adapterBytes, loaderBytes, relayBytes, identity, frameworkVersion }) {
  const h = createHash('sha256');
  for (const part of [adapterBytes, loaderBytes, relayBytes, Buffer.from(String(identity), 'utf8'), Buffer.from(String(frameworkVersion ?? ''), 'utf8')]) {
    const b = Buffer.isBuffer(part) ? part : Buffer.from(part ?? '');
    h.update(String(b.length)).update(':').update(b);
  }
  return h.digest('hex').slice(0, 16);
}

export class BuildError extends Error {
  constructor(code, message, details) { super(message); this.name = 'BuildError'; this.code = code; this.details = details; }
}


const HEX = /^(?:[0-9a-f]{2})+$/i;
const SHA = /^[0-9a-f]{64}$/;

/** Validate the shape of adapter.binaryPatches (contracts v1.10) before anything is copied. */
export function validateBinaryPatches(patches) {
  if (patches === undefined) return [];
  const bad = (id, why) => { throw new BuildError('BINARY_PATCH', `binary patch ${id}: ${why}`, { id }); };
  if (!Array.isArray(patches)) bad('?', 'binaryPatches must be an array');
  const ids = new Set();
  for (const p of patches) {
    const id = p?.id ?? '?';
    if (typeof p?.id !== 'string' || !p.id) bad(id, 'missing id');
    if (ids.has(p.id)) bad(id, 'duplicate id');
    ids.add(p.id);
    if (typeof p.file !== 'string' || !p.file || path.isAbsolute(p.file) || p.file.split('/').some((x) => x === '..' || x === '')) bad(id, `file must be a path relative to Contents/ without ".." (got ${JSON.stringify(p.file)})`);
    if (!Number.isSafeInteger(p.offset) || p.offset < 0) bad(id, 'offset must be a non-negative integer');
    if (!HEX.test(p.before ?? '') || !HEX.test(p.after ?? '')) bad(id, 'before/after must be non-empty hex');
    if (p.before.length !== p.after.length) bad(id, 'before and after must have the same length');
    if (p.before.toLowerCase() === p.after.toLowerCase()) bad(id, 'before equals after');
    if (!SHA.test(p.sha256Before ?? '') || !SHA.test(p.sha256After ?? '')) bad(id, 'sha256Before/sha256After must be 64 hex characters');
  }
  return patches;
}

/** Apply one exact-byte patch to file contents. Pure; throws BuildError on any mismatch. Returns a new Buffer. */
export function applyBinaryPatch(buf, p) {
  const fail = (code, msg) => { throw new BuildError(code, `binary patch ${p.id}: ${msg}`, { id: p.id, file: p.file }); };
  const before = sha256(buf);
  if (before !== p.sha256Before.toLowerCase()) fail('BINARY_PATCH_HASH_BEFORE', `file hash ${before} != sha256Before ${p.sha256Before}`);
  const want = Buffer.from(p.before, 'hex'), put = Buffer.from(p.after, 'hex');
  if (p.offset + want.length > buf.length) fail('BINARY_PATCH_RANGE', `offset ${p.offset}+${want.length} is past the end of the file (${buf.length} bytes)`);
  const have = buf.subarray(p.offset, p.offset + want.length);
  if (!have.equals(want)) fail('BINARY_PATCH_BYTES', `bytes at offset ${p.offset} are ${have.toString('hex')}, expected ${p.before}`);
  const out = Buffer.from(buf);
  put.copy(out, p.offset);
  const after = sha256(out);
  if (after !== p.sha256After.toLowerCase()) fail('BINARY_PATCH_HASH_AFTER', `result hash ${after} != sha256After ${p.sha256After}`);
  return out;
}

/**
 * Apply binaryPatches in array order to files under `contents` (a later patch of the same file sees the earlier result). Each file is
 * rewritten once, through a new inode, keeping its mode. Any mismatch throws before that file is touched.
 * @returns {{id: string, file: string, offset: number, length: number, sha256Before: string, sha256After: string, justification?: string}[]}
 */
export function applyBinaryPatches(contents, patches) {
  validateBinaryPatches(patches);
  const root = fs.realpathSync(contents);
  const work = new Map(); // file -> {abs, mode, buf}
  const applied = [];
  for (const p of patches) {
    let w = work.get(p.file);
    if (!w) {
      const abs = path.join(root, p.file);
      const st = fs.lstatSync(abs, { throwIfNoEntry: false });
      if (!st?.isFile()) throw new BuildError('BINARY_PATCH', `binary patch ${p.id}: ${p.file} is not a regular file in the copy`, { id: p.id });
      if (!fs.realpathSync(abs).startsWith(root + path.sep)) throw new BuildError('BINARY_PATCH', `binary patch ${p.id}: ${p.file} resolves outside Contents/`, { id: p.id });
      w = { abs, mode: st.mode & 0o7777, buf: fs.readFileSync(abs) };
      work.set(p.file, w);
    }
    w.buf = applyBinaryPatch(w.buf, p);
    applied.push({ id: p.id, file: p.file, offset: p.offset, length: p.before.length / 2, sha256Before: p.sha256Before, sha256After: p.sha256After, justification: p.justification });
  }
  for (const w of work.values()) { // all patches verified: now write
    const tmp = `${w.abs}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, w.buf, { mode: w.mode });
    fs.renameSync(tmp, w.abs);
  }
  return applied;
}

// ---- mandatory isolation edits (contracts v1.13)
/** Ids of transforms and binaryPatches present in an adapter pack. */
const editIds = (adapter) => new Set([...(adapter.transforms ?? []).map((t) => t.id), ...(adapter.binaryPatches ?? []).map((p) => p.id)]);

/** The pack lists mandatory isolation edits (keychain names, Computer Use container/identity): refuse a pack where any is missing. */
export function checkMandatoryEdits(adapter) {
  const m = adapter.mandatoryEdits;
  if (m === undefined) return [];
  if (!Array.isArray(m) || m.some((x) => typeof x !== 'string' || !x)) throw new BuildError('MANDATORY_EDITS', 'mandatoryEdits must be an array of non-empty ids');
  const have = editIds(adapter);
  const missing = m.filter((id) => !have.has(id));
  if (missing.length) throw new BuildError('MANDATORY_EDITS_MISSING', `the adapter pack lacks mandatory isolation edit(s): ${missing.join(', ')}`, { missing });
  return m;
}

/** After applying: every mandatory id must have been applied (transforms and patches abort the build on any failure, this is the cross-check). */
export function verifyMandatoryApplied(mandatory, appliedTransforms, appliedPatches) {
  const done = new Set([...appliedTransforms.map((t) => t.id), ...appliedPatches.map((p) => p.id)]);
  const missing = mandatory.filter((id) => !done.has(id));
  if (missing.length) throw new BuildError('MANDATORY_EDITS_NOT_APPLIED', `mandatory isolation edit(s) were not applied: ${missing.join(', ')}`, { missing });
  return { required: [...mandatory], applied: mandatory.filter((id) => done.has(id)) };
}

// ---- isolation baseline (ARCHITECTURE v1.14): a production build is refused unless the pack declares AND applies every one of these
/**
 * Exact edit ids: keychain primary + Aura fallback, Computer Use relocation (dir, config, installer, service path), the helper's private
 * CODEX_HOME, locked use, container. The private home is in the baseline because the app starts the helper whenever Computer Use, appshots
 * or Chronicle is on (the last two are server-gated and ignore `features.computer_use`): without it the helper inherits the app's
 * CODEX_HOME (on a daily copy the shared ~/.codex) and writes its notify line there, and the QA isolation check refuses it (m3 session 2, D3).
 */
export const ISOLATION_BASELINE_IDS = Object.freeze(['keychain-service-name', 'keychain-service-name-account', 'aura-fallback-service', 'aura-fallback-account',
  'cua-relocate-dir', 'cua-relocate-config', 'cua-relocate-installer', 'cua-service-path-env', 'cua-helper-private-home', 'cua-disable-locked-use', 'cua-container']);
/** At least one declared-and-present id must start with each of these. */
export const ISOLATION_BASELINE_PREFIXES = Object.freeze(['cua-bundle-id:', 'cua-container:']);
export const baselineRequired = () => [...ISOLATION_BASELINE_IDS, ...ISOLATION_BASELINE_PREFIXES.map((p) => `${p}*`)];

/**
 * What the pack lacks of the baseline: an id is satisfied only if it is declared in mandatoryEdits AND present as a transform/binaryPatch.
 * @param {{mandatoryEdits?: string[], transforms?: {id:string}[], binaryPatches?: {id:string}[]}} pack
 * @returns {string[]} missing entries (prefix groups as "<prefix>*"); the whole baseline when mandatoryEdits is absent or empty
 */
export function isolationBaselineMissing(pack) {
  const declared = Array.isArray(pack?.mandatoryEdits) ? pack.mandatoryEdits : [];
  if (declared.length === 0) return baselineRequired();
  const have = editIds(pack);
  const ok = (id) => declared.includes(id) && have.has(id);
  return [...ISOLATION_BASELINE_IDS.filter((id) => !ok(id)),
    ...ISOLATION_BASELINE_PREFIXES.filter((p) => !declared.some((id) => id.startsWith(p) && ok(id))).map((p) => `${p}*`)];
}

/** Delete every embedded.provisionprofile under `dir`; returns the removed paths. */
export function removeProvisionProfiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(full);
      else if (e.name === 'embedded.provisionprofile') { fs.rmSync(full, { force: true }); out.push(full); }
    }
  })(dir);
  return out;
}

// ---- team-matched Computer Use container (ARCHITECTURE v1.16)
/** OU (the Team ID) from a certificate subject line, or null. */
export const teamIdFromSubject = (subject) => /\bOU\s*=\s*([A-Z0-9]{10})\b/.exec(String(subject ?? ''))?.[1] ?? null;
/** The "(XXXXXXXXXX)" suffix of an identity name ("Developer ID Application: Name (TEAMID)"). For Apple Development certificates this is the user id, not the team: post-sign verification catches a wrong guess. */
export const teamIdFromIdentityName = (name) => /\(([A-Z0-9]{10})\)\s*$/.exec(String(name ?? ''))?.[1] ?? null;

/** Subject of the named certificate, read from the keychain's certificate record only (no private key, no prompt). */
export function findCertificateSubject(identity) {
  try {
    const pem = execFileSync('/usr/bin/security', ['find-certificate', '-c', identity, '-p'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 });
    if (!pem.includes('BEGIN CERTIFICATE')) return null;
    return execFileSync('/usr/bin/openssl', ['x509', '-noout', '-subject'], { input: pem, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 20000 });
  } catch { return null; }
}

/** Team id of a signing identity: the certificate's OU, else the name suffix. null for ad-hoc. */
export function deriveTeamId(identity, find = findCertificateSubject) {
  if (!identity || identity === '-') return null;
  return teamIdFromSubject(find(identity)) ?? teamIdFromIdentityName(identity);
}

// ---- Computer Use helper identity: binaryPatches own the edits (hash-chained patches of the helper Info.plists); the builder only VERIFIES
export const HELPER_ID_FROM = 'com.openai.sky.CUAService';
export const HELPER_ID_TO = 'com.openai.sky.CUAServicf';

/** The Computer Use rename is active in a pack when any cua-container edit is present. */
export const helperRenameActive = (adapter) => [...editIds(adapter)].some((id) => id === 'cua-container' || id.startsWith('cua-container:'));

function* plistStrings(v) {
  if (typeof v === 'string') yield v;
  else if (Array.isArray(v)) for (const x of v) yield* plistStrings(x);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) yield* plistStrings(x);
}

/**
 * After the binary patches: no helper Info.plist under Resources/cua_node may still hold the stock bundle id as a whole string value.
 * Throws HELPER_IDENTITY_STOCK listing the offenders. Returns what was checked, for the build report.
 */
export function verifyHelperIdentity(contents, { from = HELPER_ID_FROM, to = HELPER_ID_TO, subtree = 'Resources/cua_node' } = {}) {
  const base = path.join(contents, subtree);
  const out = { from, to, plists: 0, renamed: [], stockPrefixed: [] };
  const offenders = [];
  if (fs.existsSync(base)) {
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { walk(full); continue; }
        if (e.name !== 'Info.plist' || path.basename(dir) !== 'Contents') continue;
        let info; try { info = readPlistJson(full); } catch { continue; }
        out.plists += 1;
        const rel = path.relative(contents, full);
        for (const v of plistStrings(info)) {
          if (v === from) offenders.push(rel);
          else if (v === to) out.renamed.push(rel);
          else if (v.startsWith(`${from}.`)) out.stockPrefixed.push({ file: rel, value: v });
        }
      }
    })(base);
  }
  if (offenders.length) throw new BuildError('HELPER_IDENTITY_STOCK', `helper Info.plist(s) still carry the stock bundle id ${from}: ${[...new Set(offenders)].join(', ')}`, { offenders });
  return out;
}

// ---- updater suppression evidence
const SPARKLE_OFF = /CODEX_SPARKLE_ENABLED['"\]\s]*=\s*(['"`])false\1/;
/** What stops the upstream updater in this copy: plist feed gone and checks off, and the composed loader sets CODEX_SPARKLE_ENABLED=false. */
export function updaterSuppression({ plist, composedLoader }) {
  const info = readPlistJson(plist);
  const ev = { feedURLRemoved: !('SUFeedURL' in info), automaticChecksOff: info.SUEnableAutomaticChecks === false, loaderDisablesSparkle: SPARKLE_OFF.test(composedLoader) };
  return { ...ev, ok: ev.feedURLRemoved && ev.automaticChecksOff && ev.loaderDisablesSparkle };
}

/** Apply one SeamTransform to file contents. Pure; throws BuildError on any mismatch. */
export function applyTransform(buf, t) {
  const fail = (code, msg) => { throw new BuildError(code, `transform ${t.id}: ${msg}`, { id: t.id, file: t.file }); };
  if (!['replace-once', 'insert-before-once', 'insert-after-once'].includes(t.op)) fail('TRANSFORM_OP', `unknown op ${t.op}`);
  if (typeof t.find !== 'string' || t.find === '') fail('TRANSFORM_FIND', 'empty find');
  if (typeof t.text !== 'string') fail('TRANSFORM_TEXT', 'text must be a string');
  const before = sha256(buf);
  if (before !== t.sha256Before) fail('TRANSFORM_HASH_BEFORE', `file hash ${before} != sha256Before ${t.sha256Before}`);
  const str = buf.toString('utf8');
  if (!Buffer.from(str, 'utf8').equals(buf)) fail('TRANSFORM_ENCODING', 'file is not valid UTF-8');
  let count = 0;
  for (let from = 0; ;) { const i = str.indexOf(t.find, from); if (i < 0) break; count += 1; from = i + 1; }
  if (count !== 1) fail('TRANSFORM_FIND_COUNT', `find occurs ${count} times, expected exactly 1`);
  const i = str.indexOf(t.find);
  const out = t.op === 'replace-once' ? str.slice(0, i) + t.text + str.slice(i + t.find.length)
    : t.op === 'insert-before-once' ? str.slice(0, i) + t.text + str.slice(i)
      : str.slice(0, i + t.find.length) + t.text + str.slice(i + t.find.length);
  const result = Buffer.from(out, 'utf8');
  const after = sha256(result);
  if (after !== t.sha256After) fail('TRANSFORM_HASH_AFTER', `result hash ${after} != sha256After ${t.sha256After}`);
  return result;
}

// ---- parse check of the patched scripts
/** How a patched file is parsed: the renderer chunks (webview/) and `.mjs` files are ES modules, every other `.js` file of the asar is a CommonJS script, `.cjs` is a script. Null: not JavaScript. */
export function parseKind(file) {
  if (/\.mjs$/.test(file)) return 'module';
  if (/\.cjs$/.test(file)) return 'script';
  if (/\.js$/.test(file)) return file.startsWith('webview/') ? 'module' : 'script';
  return null;
}
/** Default syntax check: `node --check` over stdin (Node built-ins only; nothing is run). Throws with the parser's message. */
export function nodeCheck(kind, buf) {
  try { execFileSync(process.execPath, ['--check', ...(kind === 'module' ? ['--input-type=module'] : [])], { input: buf, stdio: ['pipe', 'ignore', 'pipe'], maxBuffer: 16 * 1024 * 1024 }); }
  catch (e) { throw new Error(String(e.stderr ?? e.message).split('\n').filter((l) => l.trim()).slice(0, 4).join(' | '), { cause: e }); }
}
/** Every patched JavaScript file must still parse; a parse error is a failed build (BuildError TRANSFORM_PARSE), before anything is written. @returns {{file: string, kind: string}[]} the files checked */
export function checkPatchedParse(patched, check = nodeCheck) {
  const checked = [];
  for (const [file, buf] of patched) {
    const kind = parseKind(file);
    if (!kind) continue;
    try { check(kind, buf); } catch (e) { throw new BuildError('TRANSFORM_PARSE', `patched ${file} does not parse as a ${kind}: ${e.message}`, { file, kind }); }
    checked.push({ file, kind });
  }
  return checked;
}

/** The loader file content: the template with the exact token '__CODEXMODS_ROOT__' (single quotes included) replaced by JSON.stringify(root), then a require of the original main. */
export const ROOT_TOKEN = "'__CODEXMODS_ROOT__'";

export function composeLoader(template, root, originalMain) {
  const rel = `./${path.posix.normalize(String(originalMain).replace(/^\.?\//, ''))}`;
  const body = template.split(ROOT_TOKEN).join(JSON.stringify(root));
  return `${body}${body.endsWith('\n') ? '' : '\n'}require(${JSON.stringify(rel)});\n`;
}

/** clonefile(2) needs source and destination on the same APFS volume; `cp -c` silently degrades to a plain copy otherwise. */
export function cloneCapable(src, destDir) {
  try {
    if (fs.statSync(src).dev !== fs.statSync(destDir).dev) return false;
    return execFileSync('/bin/df', ['-T', 'apfs', destDir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').length > 1;
  } catch { return false; }
}

function cloneTree(src, dest, log) {
  try {
    const capable = cloneCapable(src, path.dirname(dest));
    execFileSync('/bin/cp', ['-c', '-R', src, dest], { stdio: 'pipe' });
    return capable ? 'clonefile' : 'copy';
  } catch (e) {
    log(`cp -c failed (${String(e.stderr || e.message).trim().split('\n')[0]}); falling back to ditto`);
    fs.rmSync(dest, { recursive: true, force: true });
    execFileSync('/usr/bin/ditto', [src, dest], { stdio: 'pipe' });
    return 'ditto';
  }
}

/** realpath of the longest existing prefix of p, with the non-existing tail re-appended. */
function canonical(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...tail.reverse()); } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      tail.push(path.basename(cur));
      const parent = path.dirname(cur);
      if (parent === cur) return path.join(cur, ...tail.reverse());
      cur = parent;
    }
  }
}

const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

/**
 * Canonicalize --out (and every existing ancestor, via realpath) before anything is deleted. Refuse when the canonical out
 * is inside or equal to the canonical stock app, /Applications, the home root, or a protected root; or when it contains
 * any of those (it would delete them). Symlink aliases resolve to their targets first, so an alias into stock is caught.
 */
export function assertSafeOut(out, stock, { home = process.env.HOME } = {}) {
  const o = canonical(out), s = canonical(stock);
  const protectedRoots = ['/', '/Applications', '/System', '/Library', '/Users', '/usr', '/bin', '/sbin', '/private', '/var', '/etc'].map(canonical);
  if (home) protectedRoots.push(canonical(home));
  const bad = (why) => { throw new BuildError('OUT_UNSAFE', `refusing unsafe --out ${out} (resolves to ${o}): ${why}`); };
  if (inside(o, s)) bad(`inside the stock app ${s}`);
  if (inside(s, o)) bad(`contains the stock app ${s}`);
  if (inside(o, canonical('/Applications'))) bad('inside /Applications');
  for (const r of protectedRoots) if (o === r || inside(r, o)) bad(`is or contains the protected path ${r}`);
  return o;
}

function loadAdapter(adapter) {
  if (typeof adapter !== 'string') { const bytes = Buffer.from(JSON.stringify(adapter)); return { json: adapter, bytes, sha256: sha256(bytes), path: null }; }
  const raw = fs.readFileSync(adapter);
  return { json: JSON.parse(raw.toString('utf8')), bytes: raw, sha256: sha256(raw), path: path.resolve(adapter) };
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * @param {object} opts
 * @param {string} opts.stock stock .app
 * @param {string|object} opts.adapter adapter.json path or AdapterPack object
 * @param {string} opts.loader loader template (.cjs) containing __CODEXMODS_ROOT__
 * @param {string} opts.relay relay executable
 * @param {string} opts.root framework root baked into the loader
 * @param {string} opts.identity signing identity name, or '-' for ad-hoc
 * @param {string} opts.out output directory
 * @param {boolean} [opts.requireIdentity] refuse the ad-hoc identity '-' (daily setup)
 * @param {string} [opts.teamId] Team ID of the signing identity when it cannot be derived (certificate OU or "(TEAMID)" suffix)
 * @param {boolean} [opts.qaNoRestore] QA only: NSDisablePersistence in the signed Info.plist
 * @param {boolean} [opts.qaSocketDirs] QA only: relocate main's /tmp socket directories into the profile (qa-socket-dirs.mjs)
 * @param {boolean} [opts.allowNoBaseline] diagnostics only (qa control, unit fixtures): skip the isolation baseline requirement
 * @param {boolean} [opts.allowUpdater] diagnostics only: do not refuse a copy whose updater suppression evidence is incomplete (default: refuse)
 * @param {string} [opts.frameworkVersion] framework version, an input of inputsHash
 * @param {string} [opts.name]
 * @param {boolean} [opts.force]
 * @param {Function} [opts.sign] test seam, defaults to signBundle
 * @param {(kind: 'module'|'script', buf: Buffer) => void} [opts.parseCheck] test seam for the syntax check of the patched scripts, defaults to `node --check` (nodeCheck)
 * @param {(m:string)=>void} [opts.log]
 * @returns {Promise<{appPath: string, reportPath: string, report: object}>}
 */
export async function buildCopy(opts) {
  const t0 = Date.now();
  const log = opts.log ?? (() => {});
  const name = opts.name ?? 'ChatGPT Mods';
  const sign = opts.sign ?? signBundle;
  for (const k of ['stock', 'adapter', 'loader', 'relay', 'root', 'identity', 'out']) {
    if (!opts[k]) throw new BuildError('ARG', `buildCopy: missing option ${k}`);
  }
  if (!path.isAbsolute(opts.root)) throw new BuildError('ARG', '--root must be an absolute path');
  if (/[/\0]/.test(name)) throw new BuildError('ARG', 'invalid --name');
  const stock = path.resolve(opts.stock);
  const out = assertSafeOut(opts.out, stock); // canonical from here on: every later write/delete uses it

  // ---- preflight: nothing is written until every input checks out
  const { json: adapter, bytes: adapterBytes, sha256: adapterSha, path: adapterPath } = loadAdapter(opts.adapter);
  if (!adapter?.asarPackageJson || !adapter.backend?.codexPath || !['replace', 'override'].includes(adapter.backend.method)) {
    throw new BuildError('ADAPTER', 'adapter lacks asarPackageJson / backend.codexPath / backend.method');
  }
  if (adapter.backend.method === 'override' && !adapter.backend.configKey) throw new BuildError('ADAPTER', 'backend.method "override" requires configKey');
  const transforms = adapter.transforms ?? [];
  validateBinaryPatches(adapter.binaryPatches);
  const mandatory = checkMandatoryEdits(adapter);
  if (!opts.allowNoBaseline) {
    const baselineMissing = isolationBaselineMissing(adapter);
    if (baselineMissing.length) throw new BuildError('ISOLATION_BASELINE', `the adapter pack does not declare and apply the isolation baseline; missing: ${baselineMissing.join(', ')}`, { missing: baselineMissing });
  }
  if (opts.requireIdentity && (!opts.identity || opts.identity === '-')) throw new BuildError('IDENTITY_REQUIRED', 'an ad-hoc signing identity ("-") is refused here: pass a real signing identity (--require-identity)');
  let teamId = null;
  if (opts.identity !== '-' && helperRenameActive(adapter)) {
    teamId = opts.teamId ?? deriveTeamId(opts.identity, opts.findCertificateSubject ?? findCertificateSubject);
    if (!TEAM_RE.test(teamId ?? '')) throw new BuildError('TEAM_ID', `cannot derive a 10-character Team ID from the signing identity ${JSON.stringify(opts.identity)} (certificate OU or "(TEAMID)" suffix); pass --team-id`);
  }
  const loaderBytes = fs.readFileSync(opts.loader);
  const loaderTemplate = loaderBytes.toString('utf8');
  if (!loaderTemplate.includes(ROOT_TOKEN)) throw new BuildError('LOADER', `loader does not contain the token ${ROOT_TOKEN} (with its single quotes)`);
  const relayStat = fs.statSync(opts.relay);
  if (!relayStat.isFile()) throw new BuildError('RELAY', 'relay is not a file');
  const stockInfo = readPlistJson(path.join(stock, 'Contents', 'Info.plist'));
  const stockAsar = path.join(stock, 'Contents', ASAR_REL);
  if (adapter.build?.version && adapter.build.version !== stockInfo.CFBundleShortVersionString) {
    throw new BuildError('ADAPTER_BUILD', `adapter is for ${adapter.build.version}, stock is ${stockInfo.CFBundleShortVersionString}`);
  }
  if (adapter.build?.bundleVersion && adapter.build.bundleVersion !== stockInfo.CFBundleVersion) {
    throw new BuildError('ADAPTER_BUILD', `adapter is for bundle ${adapter.build.bundleVersion}, stock is ${stockInfo.CFBundleVersion}`);
  }

  if (fs.existsSync(out)) {
    const entries = fs.readdirSync(out);
    if (entries.length && !opts.force) throw new BuildError('OUT_NOT_EMPTY', `--out is not empty: ${out} (use --force)`);
    for (const e of entries) fs.rmSync(path.join(out, e), { recursive: true, force: true });
  } else fs.mkdirSync(out, { recursive: true, mode: 0o700 });

  const staging = path.join(out, '.partial');
  const stagedApp = path.join(staging, `${name}.app`);
  const finalApp = path.join(out, `${name}.app`);
  fs.mkdirSync(staging, { mode: 0o700 });
  try {
    const stockAsarFileSha = sha256File(stockAsar);
    const stockAsarHeaderSha = AsarArchive.open(stockAsar).headerSha256;
    if (adapter.build?.asarSha256 && adapter.build.asarSha256 !== stockAsarFileSha) {
      throw new BuildError('ADAPTER_BUILD', `adapter asarSha256 ${adapter.build.asarSha256} != sha256 of the stock app.asar file ${stockAsarFileSha}`);
    }

    // ---- 1. clone
    const cloneMethod = cloneTree(stock, stagedApp, log);
    log(`cloned via ${cloneMethod}`);
    const contents = path.join(stagedApp, 'Contents');
    const plist = path.join(contents, 'Info.plist');
    fs.chmodSync(plist, 0o644);

    // ---- 2. identity
    setPlistString(plist, 'CFBundleIdentifier', BUNDLE_ID);
    setPlistString(plist, 'CFBundleName', name);
    setPlistString(plist, 'CFBundleDisplayName', name);
    setPlistString(plist, 'CrProductDirName', BUNDLE_ID);
    const removedKeys = ['CFBundleURLTypes', 'SUFeedURL'].filter((k) => removePlistKey(plist, k));
    setPlistBool(plist, 'SUEnableAutomaticChecks', false);
    // QA only. Mozilla documents this AppKit opt-out (bug 967970); never change ordinary/daily copies.
    if (opts.qaNoRestore) setPlistBool(plist, 'NSDisablePersistence', true);
    // Owl (this build's Chromium runtime) injects --user-data-dir=~/Library/Application Support/<UserDataDirectoryName> before any
    // JS runs and app.setPath('userData') cannot override it. A copy must not default to the stock app's directory.
    const owlRel = adapter.owl?.iniPath ?? DEFAULT_OWL_INI;
    const udName = adapter.owl?.userDataDirectoryName ?? DEFAULT_USER_DATA_DIRECTORY_NAME;
    const owlIni = path.join(contents, owlRel);
    let owl = null;
    if (fs.existsSync(owlIni)) {
      const before = fs.readFileSync(owlIni, 'utf8');
      const m = /^UserDataDirectoryName=(.*?)(\r?)$/m.exec(before);
      if (m) {
        fs.chmodSync(owlIni, 0o644);
        fs.writeFileSync(owlIni, before.replace(/^UserDataDirectoryName=.*?(\r?)$/m, () => `UserDataDirectoryName=${udName}${m[2]}`));
        owl = { file: `Contents/${owlRel}`, userDataDirectoryName: { from: m[1], to: udName } };
      }
    }

    // ---- 3. loader into the asar
    const asarPath = path.join(contents, ASAR_REL);
    const asar = AsarArchive.open(asarPath);
    const mods = new Map();
    const pkgRaw = asar.read(adapter.asarPackageJson).toString('utf8');
    const pkg = JSON.parse(pkgRaw);
    if (typeof pkg.main !== 'string' || !pkg.main) throw new BuildError('ASAR_PACKAGE', `${adapter.asarPackageJson} has no "main"`);
    const originalMain = pkg.main;
    pkg.main = LOADER_NAME;
    const indent = /^\{\n( +)"/.exec(pkgRaw)?.[1]?.length ?? 2;
    mods.set(adapter.asarPackageJson, Buffer.from(`${JSON.stringify(pkg, null, indent)}${pkgRaw.endsWith('\n') ? '\n' : ''}`, 'utf8'));
    const loaderPath = path.posix.join(path.posix.dirname(adapter.asarPackageJson), LOADER_NAME);
    if (asar.node(loaderPath)) throw new BuildError('ASAR_PACKAGE', `${loaderPath} already exists in app.asar`);
    const composedLoader = composeLoader(loaderTemplate, opts.root, originalMain);
    const adds = new Map([[loaderPath, Buffer.from(composedLoader, 'utf8')]]);

    // ---- 4. transforms, in order, all verified before anything is written
    const applied = [];
    for (const t of transforms) {
      const cur = mods.get(t.file) ?? (adds.get(t.file) ?? (asar.node(t.file) ? asar.read(t.file) : null));
      if (!cur) throw new BuildError('TRANSFORM_FILE', `transform ${t.id}: no such file in app.asar: ${t.file}`, { id: t.id });
      const next = applyTransform(cur, t);
      if (adds.has(t.file)) adds.set(t.file, next); else mods.set(t.file, next);
      applied.push({ id: t.id, seam: t.seam, file: t.file, op: t.op, sha256Before: t.sha256Before, sha256After: t.sha256After });
    }

    // ---- 4a. QA only (adapter NOTES N8): main's fixed /tmp socket directories move into the QA profile; never in product copies
    let qaSocketDirs = null;
    if (opts.qaSocketDirs) {
      const scan = new Map([...new Set([...asar.list(), ...adds.keys()])].filter((p) => QA_SOCKET_SCAN.test(p)).map((p) => [p, mods.get(p) ?? adds.get(p) ?? asar.read(p)]));
      let r;
      try { r = applyQaSocketDirs(scan, opts.root); } catch (e) { throw e.code === 'QA_SOCKET_ANCHOR' ? new BuildError(e.code, e.message, e.details) : e; }
      for (const [p, buf] of r.edits) { if (adds.has(p)) adds.set(p, buf); else mods.set(p, buf); }
      qaSocketDirs = r.report;
    }

    // ---- 4a'. every patched script must still parse (a transform that breaks the syntax of a chunk fails the build here, not in the running app)
    const parseChecked = checkPatchedParse(mods, opts.parseCheck ?? nodeCheck);

    // ---- 4b. exact-byte patches to Mach-O files outside the asar (before the framework digest patch and before signing)
    const binaryPatches = applyBinaryPatches(contents, adapter.binaryPatches ?? []);
    const mandatoryReport = verifyMandatoryApplied(mandatory, applied, binaryPatches);

    // ---- 4b'. the privileged locked-use installer payload does not ship in the copy (ARCHITECTURE v1.16)
    const removedLockedUsePayload = removeLockedUsePayload(contents);
    const leftovers = lockedUseLeftovers(contents);
    if (leftovers.length) throw new BuildError('LOCKED_USE_PAYLOAD', `locked-use installer payload still present under the Computer Use tree: ${leftovers.slice(0, 8).join(', ')}`, { leftovers });
    const appliedIds = new Set([...applied.map((x) => x.id), ...binaryPatches.map((x) => x.id)]);
    const isolationBaseline = opts.allowNoBaseline ? { skipped: true, required: [], applied: [], missing: [] } : (() => {
      const required = baselineRequired();
      const done = [...ISOLATION_BASELINE_IDS.filter((id) => appliedIds.has(id)), ...ISOLATION_BASELINE_PREFIXES.filter((p) => [...appliedIds].some((id) => id.startsWith(p))).map((p) => `${p}*`)];
      const missing = required.filter((r) => !done.includes(r));
      if (missing.length) throw new BuildError('ISOLATION_BASELINE', `isolation baseline edit(s) were not applied: ${missing.join(', ')}`, { missing });
      return { required, applied: done, missing };
    })();

    // ---- 4c. the copy's own Computer Use helper identity was written by the binaryPatches above: verify it (fail closed)
    let helperIdentity = null;
    if (helperRenameActive(adapter)) {
      helperIdentity = verifyHelperIdentity(contents);
      if (!helperIdentity.renamed.length) throw new BuildError('HELPER_IDENTITY', `the Computer Use rename is in the pack but no helper Info.plist under Resources/cua_node carries ${HELPER_ID_TO}`);
    }

    // ---- 4c''. the helper bundles ship the stock team's provisioning profiles (stock application-identifier and app group); they cannot apply to the
    // copy's identity and carry the stock identity bytes, so they go, like the main app's own profile at signing time.
    const removedProvisionProfiles = removeProvisionProfiles(path.join(contents, 'Resources', 'cua_node')).map((p) => path.relative(contents, p));

    // ---- 4c'. team-matched container, then the content scan: no stock Computer Use identity may survive in the helper tree or in the asar's main/src/worker bundles
    let scanTargets = asar.list().filter((p) => ASAR_SCAN_PATTERN.test(p)).map((p) => ({ path: p, buf: mods.get(p) ?? adds.get(p) ?? asar.read(p) }));
    let computerUseContainer = { id: OLD_GROUP, teamId: null, sites: 0, siteList: [], entitled: [], required: [] };
    let computerUseTeamRewrite = { team: null, sites: [] };
    let nativePeerAuthRewrite = null;
    if (teamId) {
      const rw = rewriteTeamGroup(contents, scanTargets, teamId);
      for (const [p, buf] of rw.asar) { if (adds.has(p)) adds.set(p, buf); else mods.set(p, buf); }
      scanTargets = scanTargets.map((tg) => (rw.asar.has(tg.path) ? { ...tg, buf: rw.asar.get(tg.path) } : tg));
      computerUseContainer = { id: `${teamId}.${OLD_GROUP.slice(OLD_GROUP.indexOf('.') + 1)}`, teamId, sites: rw.total, siteList: rw.sites, entitled: [], required: [] };
      // the helper pins its clients/parent by OpenAI's bare Team ID (service strings, SkyComputerUseClient_Parent.coderequirement, ...): re-pin to ours, in every cua_node file
      const tr = rewriteComputerUseTeam(contents, teamId);
      computerUseTeamRewrite = { team: teamId, from: STOCK_TEAM, sites: tr.sites };
      const teamLeft = stockTeamLeftovers(contents);
      if (teamLeft.length) throw new BuildError('ISOLATION_SCAN', `stock team id ${STOCK_TEAM} still present under Resources/cua_node after the team rewrite (${teamLeft.length}): ${teamLeft.slice(0, 8).map((h) => `${h.file}@${h.offset} [${h.encoding}]`).join('; ')}`, { hits: teamLeft });
      if (!rw.total) throw new BuildError('TEAM_CONTAINER', `a team build (${teamId}) found no ${OLD_GROUP} site to rewrite: the pack's cua-container edits did not produce the container id`);
      // ---- 4c'''. adapter NOTES N9: browser-use-peer-authorization.node (under Resources/native, NOT cua_node) pins main's app-tools and
      // in-app-browser socket peers by OpenAI's bare Team ID, so main rejects the copy's re-signed node_repl (dynamic_app_tools_peer_rejected,
      // reason=untrusted-code-signing-identity). Re-pin it to ours too — the same same-length bare-team rewrite the cua_node tree already gets;
      // the whole-app re-sign in step 7 re-seals the addon. Fail closed if the one expected site is missing or has drifted.
      try { nativePeerAuthRewrite = rewriteNativePeerAuthTeam(contents, teamId); }
      catch (e) { throw e instanceof NativePeerAuthError ? new BuildError(e.code, e.message, e.details) : e; }
    }
    const isolationScanReport = opts.allowNoBaseline ? { skipped: true, files: 0, hits: [], allowlisted: [], signatureSkipped: 0 } : isolationScan(contents, scanTargets, { forbidOldGroup: !!teamId });
    if (isolationScanReport.hits.length) {
      throw new BuildError('ISOLATION_SCAN', `stock Computer Use identity still present after all edits (${isolationScanReport.hits.length} hit(s)): ${isolationScanReport.hits.slice(0, 12).map((h) => `${h.file}@${h.offset} [${h.kind}/${h.encoding}]`).join('; ')}`, { hits: isolationScanReport.hits });
    }

    // ---- 4d. updater suppression evidence
    const updater = updaterSuppression({ plist, composedLoader });
    if (!opts.allowUpdater && !updater.ok) throw new BuildError('UPDATER_NOT_SUPPRESSED', `the upstream updater is not fully suppressed in this copy: ${JSON.stringify(updater)}`, updater);

    // ---- 5. rewrite the asar and its integrity
    const oldIntegrity = readPlistJson(plist).ElectronAsarIntegrity;
    const newAsarTmp = `${asarPath}.new`;
    const w = writeAsar(asar, newAsarTmp, { replace: mods, add: adds });
    asar.close();
    fs.renameSync(newAsarTmp, asarPath);
    const check = AsarArchive.open(asarPath);
    if (check.headerSha256 !== w.headerSha256) throw new BuildError('ASAR_WRITE', 'rewritten asar header hash mismatch');
    for (const p of [...mods.keys(), ...adds.keys()]) if (!check.verifyFile(p)) throw new BuildError('ASAR_WRITE', `integrity mismatch after rewrite: ${p}`);
    check.close();
    const plistUpdate = rewritePlistIntegrity(plist, ASAR_REL, oldIntegrity?.[ASAR_REL]?.hash, w.headerSha256);
    const stagedReal = fs.realpathSync(stagedApp);
    const fw = patchFrameworkDigest(stagedApp, oldIntegrity, plistUpdate.integrity).map((f) => ({ ...f, path: path.relative(stagedReal, f.path) }));
    log(`asar rewritten (${w.size} bytes), header ${w.headerSha256}; framework digest ${fw.map((f) => (f.present ? 'patched' : 'absent')).join(',') || 'none'}`);

    // ---- 6. backend
    const codexAbs = path.join(contents, adapter.backend.codexPath);
    const relayMode = 0o755;
    let backend;
    if (adapter.backend.method === 'replace') {
      const st = fs.lstatSync(codexAbs, { throwIfNoEntry: false });
      if (!st?.isFile()) throw new BuildError('BACKEND', `backend binary not found (regular file) at ${adapter.backend.codexPath}`);
      if (fs.existsSync(`${codexAbs}.real`)) throw new BuildError('BACKEND', `${adapter.backend.codexPath}.real already exists`);
      fs.renameSync(codexAbs, `${codexAbs}.real`);
      fs.copyFileSync(opts.relay, codexAbs);
      fs.chmodSync(codexAbs, relayMode);
      backend = { method: 'replace', codexPath: adapter.backend.codexPath, realPath: `${adapter.backend.codexPath}.real` };
    } else {
      const dest = path.join(contents, OVERRIDE_RELAY_REL);
      fs.copyFileSync(opts.relay, dest);
      fs.chmodSync(dest, relayMode);
      // The relay falls back to `$0.real` when CODEX_MODS_REAL_CODEX is absent. Processes the backend starts with a reduced
      // environment (MCP servers such as node_repl and cua_repl, which get only CODEX_CLI_PATH) need that fallback, so it points at
      // the real binary: a relative symlink inside the bundle, sealed by the signature.
      if (!fs.lstatSync(codexAbs, { throwIfNoEntry: false })?.isFile()) throw new BuildError('BACKEND', `backend binary not found (regular file) at ${adapter.backend.codexPath}`);
      fs.symlinkSync(path.relative(path.dirname(dest), codexAbs), `${dest}.real`);
      backend = {
        method: 'override', codexPath: adapter.backend.codexPath, configKey: adapter.backend.configKey,
        relayPath: `Contents/${OVERRIDE_RELAY_REL}`, realLink: `Contents/${OVERRIDE_RELAY_REL}.real`,
        mustConfigure: `set ${adapter.backend.configKey} to [<absolute path of Contents/${OVERRIDE_RELAY_REL} in the launched copy>] and set CODEX_MODS_REAL_CODEX to the real binary at Contents/${adapter.backend.codexPath}`,
      };
    }

    // ---- 7. sign and verify
    // v1.5: the exact adapter.json bytes this copy was built with, sealed by the signature below; framework-main reads this file.
    const embeddedRel = 'Resources/codexmods-adapter.json';
    fs.writeFileSync(path.join(contents, embeddedRel), adapterBytes, { mode: 0o644 });
    for (const stale of ['CodeResources', 'embedded.provisionprofile']) fs.rmSync(path.join(contents, stale), { force: true }); // stock notarization ticket and team provisioning profile
    try { execFileSync('/usr/bin/xattr', ['-cr', stagedApp], { stdio: 'pipe' }); } catch { /* best effort */ }
    const signing = await sign(stagedApp, { identity: opts.identity, workDir: path.join(staging, 'sign'), log, appGroup: teamId ? computerUseContainer.id : null, entitlementSourceRoot: stock });
    computerUseContainer.entitled = (signing.targets ?? []).filter((x) => x.entitled).map((x) => x.path);
    computerUseContainer.required = signing.required ?? (signing.targets ?? []).filter((x) => x.requiredGroup).map((x) => x.path).sort();
    if (teamId && !computerUseContainer.entitled.length) throw new BuildError('TEAM_CONTAINER', 'no executable was signed with the team-matched application-groups entitlement');

    // ---- 7b. post-sign: the entitlements actually embedded must carry no stock token and no foreign-team app group
    const signedPaths = (signing.targets ?? []).map((x) => x.path);
    const signerTeam = opts.identity === '-' ? null : await (opts.readTeamIdentifier ?? readTeamIdentifier)(stagedApp);
    if (opts.identity !== '-' && teamId && signerTeam !== teamId) throw new BuildError('TEAM_ID_MISMATCH', `the signature's Team ID is ${signerTeam ?? 'unset'}, the container was rewritten for ${teamId}`, { signerTeam, teamId });
    const signedEnts = await (opts.dumpSignedEntitlements ?? dumpSignedEntitlements)(stagedApp, signedPaths);
    const entHits = signedEnts.flatMap(({ path: p, ents }) => scanText(JSON.stringify(ents ?? {}), `entitlements:${p}`, { forbidOldGroup: !!teamId }).map((h) => ({ ...h, encoding: 'entitlement-json' })));
    if (entHits.length) throw new BuildError('ISOLATION_SCAN', `stock Computer Use identity in signed entitlements (${entHits.length}): ${entHits.slice(0, 8).map((h) => `${h.file} [${h.kind}]`).join('; ')}`, { hits: entHits, postSign: true });
    if (teamId) { // the signing must not have reintroduced (or left) the stock team id in the Computer Use tree or in the native peer-auth addon (N9)
      const stagedContents = path.join(stagedApp, 'Contents');
      const left = ['Resources/cua_node', 'Resources/native'].flatMap((subtree) => stockTeamLeftovers(stagedContents, { subtree }));
      if (left.length) throw new BuildError('ISOLATION_SCAN', `stock team id ${STOCK_TEAM} present under Resources/cua_node or Resources/native after signing (${left.length}): ${left.slice(0, 8).map((h) => `${h.file}@${h.offset} [${h.encoding}]`).join('; ')}`, { hits: left, postSign: true });
    }
    const groupCheck = evaluateSignedGroups(signedEnts, signerTeam);
    if (groupCheck.mismatches.length) throw new BuildError('ENTITLEMENT_TEAM', `app-group entitlement(s) not matching the signer (${signerTeam ?? 'ad-hoc'}): ${groupCheck.mismatches.slice(0, 6).map((m) => `${m.path}: ${m.group} (${m.why})`).join('; ')}`, groupCheck);
    // the actual embedded grants of every required executable (not the signing plan): exactly the team-matched group
    if (teamId) {
      const byPath = new Map(signedEnts.map((x) => [x.path, x.ents]));
      const lacking = computerUseContainer.required.filter((p) => JSON.stringify(byPath.get(p)?.['com.apple.security.application-groups'] ?? null) !== JSON.stringify([computerUseContainer.id]));
      if (lacking.length) throw new BuildError('ENTITLEMENT_MISSING', `required executable(s) lack exactly [${computerUseContainer.id}] as embedded app groups: ${lacking.join(', ')}`, { missing: lacking, expected: [computerUseContainer.id] });
    }
    const postSignEntitlements = { objects: signedEnts.length, hits: 0, signerTeam, groups: groupCheck.groups };
    fs.rmSync(path.join(staging, 'sign'), { recursive: true, force: true });

    // ---- 8. commit: move into place, then write the report (the completeness marker)
    fs.renameSync(stagedApp, finalApp);
    fs.rmSync(staging, { recursive: true, force: true });
    const removed = new Set(); const added = new Set();
    for (const t of signing.targets ?? []) { t.removed?.forEach((k) => removed.add(k)); t.added?.forEach((k) => added.add(k)); }
    const report = {
      schema: 1, complete: true, builtAt: new Date().toISOString(), durationMs: Date.now() - t0,
      embeddedAdapter: { path: `Contents/${embeddedRel}`, sha256: sha256(adapterBytes) },
      inputsHash: buildInputsHash({ adapterBytes, loaderBytes, relayBytes: fs.readFileSync(opts.relay), identity: opts.identity, frameworkVersion: opts.frameworkVersion ?? '' }),
      frameworkVersion: opts.frameworkVersion ?? null,
      app: finalApp, name, bundleId: BUNDLE_ID, cloneMethod,
      stock: { path: stock, version: stockInfo.CFBundleShortVersionString, bundleVersion: stockInfo.CFBundleVersion, asarSha256: stockAsarFileSha, asarHeaderSha256: stockAsarHeaderSha, electronAsarIntegrity: oldIntegrity },
      inputs: { adapter: { path: adapterPath, sha256: adapterSha, adapterVersion: adapter.adapterVersion ?? null, build: adapter.build ?? null }, loaderSha256: sha256(Buffer.from(loaderTemplate)), relaySha256: sha256File(opts.relay), root: opts.root },
      infoPlist: { bundleIdentifier: BUNDLE_ID, removedKeys, qaNoRestore: !!opts.qaNoRestore }, owl,
      qaSocketDirs: qaSocketDirs ?? { applied: false },
      loader: { path: loaderPath, originalMain },
      transforms: applied,
      parseChecked,
      binaryPatches,
      mandatoryEdits: mandatoryReport,
      isolationBaseline,
      removedLockedUsePayload,
      computerUseContainer,
      computerUseTeamRewrite,
      nativePeerAuthRewrite,
      postSignEntitlements,
      removedProvisionProfiles,
      isolationScan: { ...(isolationScanReport.skipped ? { skipped: true } : {}), files: isolationScanReport.files, hits: isolationScanReport.hits.length, allowlisted: isolationScanReport.allowlisted, signatureSkipped: isolationScanReport.signatureSkipped },
      computerUseHelperIdentity: helperIdentity,
      updater,
      integrity: { asarHeaderSha256: w.headerSha256, asarSize: w.size, dictionaryDigest: dictionaryDigest(plistUpdate.integrity), framework: fw.map((f) => ({ path: f.path, present: f.present, oldDigest: f.oldDigest, newDigest: f.newDigest })) },
      backend,
      signing: { identity: opts.identity, adhoc: opts.identity === '-', signed: signing.signed, strippedEntitlements: [...removed].sort(), addedEntitlements: [...added].sort() },
    };
    const reportPath = path.join(out, 'build-report.json');
    writeJsonAtomic(reportPath, report);
    return { appPath: finalApp, reportPath, report };
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(finalApp, { recursive: true, force: true });
    throw e;
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      stock: { type: 'string' }, adapter: { type: 'string' }, loader: { type: 'string' }, relay: { type: 'string' },
      root: { type: 'string' }, 'framework-version': { type: 'string' }, identity: { type: 'string' }, out: { type: 'string' }, name: { type: 'string' }, force: { type: 'boolean' },
      'qa-no-restore': { type: 'boolean' }, 'qa-socket-dirs': { type: 'boolean' }, 'require-identity': { type: 'boolean' }, 'allow-updater': { type: 'boolean' }, 'allow-no-isolation-baseline': { type: 'boolean' }, 'team-id': { type: 'string' },
    },
  });
  const r = await buildCopy({ ...values, frameworkVersion: values['framework-version'], qaNoRestore: values['qa-no-restore'], qaSocketDirs: values['qa-socket-dirs'], requireIdentity: values['require-identity'], allowUpdater: values['allow-updater'], allowNoBaseline: values['allow-no-isolation-baseline'], teamId: values['team-id'], log: (m) => process.stderr.write(`[builder] ${m}\n`) });
  process.stdout.write(`${r.appPath}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { process.stderr.write(`build failed: ${e.code ? `[${e.code}] ` : ''}${e.message}\n`); process.exit(1); });
}
