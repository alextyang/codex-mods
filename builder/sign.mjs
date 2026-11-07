// Uniform inside-out signing (ARCHITECTURE.md §5 step 5, decision D3). Every Mach-O in the bundle gets one identity.
// Mixed signatures cannot work: an ad-hoc hardened executable cannot load a dylib from another team.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readPlistJson } from './integrity.mjs';

const execFileP = promisify(execFile);
const CODESIGN = '/usr/bin/codesign';
const PLUTIL = '/usr/bin/plutil';
export const DISABLE_LIBRARY_VALIDATION = 'com.apple.security.cs.disable-library-validation';
const BUNDLE_SUFFIXES = ['.app', '.appex', '.docktileplugin', '.framework', '.plugin', '.xpc', '.bundle'];

/** Team-scoped entitlements cannot be honoured under another identity: signing with them makes the binary unlaunchable. */
export function isTeamScoped(key) {
  return key === 'application-identifier' || key === 'com.apple.application-identifier'
    || key === 'team-identifier' || key === 'com.apple.developer.team-identifier'
    || key === 'aps-environment' || key === 'keychain-access-groups'
    || key === 'com.apple.security.application-groups' || key === 'application-groups'
    || key.startsWith('com.apple.developer.');
}

/**
 * @param {Record<string, unknown>} source entitlements read from the stock signature
 * @param {{identity: string, executable: boolean}} opts
 * @returns {{entitlements: Record<string, unknown>, removed: string[], added: string[]}}
 */
export const APP_GROUPS = 'com.apple.security.application-groups';
export function filterEntitlements(source, { identity, executable, appGroup = null }) {
  const entitlements = {};
  const removed = [];
  for (const [k, v] of Object.entries(source ?? {})) {
    if (isTeamScoped(k)) removed.push(k); else entitlements[k] = v;
  }
  const added = [];
  if (identity === '-' && executable && entitlements[DISABLE_LIBRARY_VALIDATION] !== true) {
    entitlements[DISABLE_LIBRARY_VALIDATION] = true;
    added.push(DISABLE_LIBRARY_VALIDATION);
  }
  // Team-matched container (ARCHITECTURE v1.16): the only app group an executable may keep is the copy's own team-prefixed one, and only when asked.
  let entitled = false;
  if (appGroup && executable) { entitlements[APP_GROUPS] = [appGroup]; added.push(APP_GROUPS); entitled = true; }
  return { entitlements, removed: removed.sort(), added, entitled };
}

/** Mach-O file type of the file at p: 'execute' | 'dylib' | 'bundle' | 'other', or null if not Mach-O. */
export function machoKind(p) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const h = Buffer.alloc(32);
    const n = fs.readSync(fd, h, 0, 32, 0);
    if (n < 8) return null;
    const be = h.readUInt32BE(0);
    let fileType;
    if (be === 0xcafebabe || be === 0xcafebabf) {
      const narch = h.readUInt32BE(4);
      if (narch < 1 || narch > 8) return null; // a Java class file, not a fat Mach-O
      const entry = Buffer.alloc(24);
      fs.readSync(fd, entry, 0, 24, 8);
      const off = be === 0xcafebabe ? entry.readUInt32BE(8) : Number(entry.readBigUInt64BE(8));
      const mh = Buffer.alloc(16);
      fs.readSync(fd, mh, 0, 16, off);
      fileType = mh.readUInt32LE(0) === 0xfeedfacf || mh.readUInt32LE(0) === 0xfeedface ? mh.readUInt32LE(12) : mh.readUInt32BE(12);
    } else {
      const le = h.readUInt32LE(0);
      if (le === 0xfeedfacf || le === 0xfeedface) fileType = h.readUInt32LE(12);
      else if (be === 0xfeedfacf || be === 0xfeedface) fileType = h.readUInt32BE(12);
      else return null;
    }
    return { 2: 'execute', 6: 'dylib', 8: 'bundle' }[fileType] ?? 'other';
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* */ } }
}

/** CFBundleExecutable path of a bundle directory, or null. */
function bundleMainExecutable(dir) {
  const candidates = [path.join(dir, 'Contents', 'Info.plist'), path.join(dir, 'Resources', 'Info.plist'), path.join(dir, 'Info.plist'), path.join(dir, 'Versions', 'Current', 'Resources', 'Info.plist')];
  for (const plist of candidates) {
    if (!fs.existsSync(plist)) continue;
    try {
      const exe = readPlistJson(plist).CFBundleExecutable;
      if (!exe) continue;
      const base = path.dirname(plist);
      const options = [path.join(base, 'MacOS', exe), path.join(path.dirname(base), 'MacOS', exe), path.join(path.dirname(base), exe), path.join(dir, exe)];
      for (const o of options) if (fs.existsSync(o)) return fs.realpathSync(o);
    } catch { /* unreadable plist: treat as no main executable */ }
  }
  return null;
}

/**
 * Enumerate signing targets under root (root itself last): bundles and loose Mach-O files, no symlinks followed.
 * @returns {{path: string, type: 'bundle'|'file', kind?: string, main?: string|null, depth: number}[]} inside-out order
 */
export function listSigningTargets(root) {
  root = path.resolve(root);
  const targets = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (BUNDLE_SUFFIXES.some((s) => e.name.endsWith(s))) targets.push({ path: full, type: 'bundle', main: bundleMainExecutable(full) });
        walk(full);
      } else if (e.isFile()) {
        const kind = machoKind(full);
        if (kind && kind !== 'other') targets.push({ path: full, type: 'file', kind });
      }
    }
  })(root);
  const mains = new Set(targets.filter((t) => t.type === 'bundle' && t.main).map((t) => t.main));
  const rootMain = bundleMainExecutable(root);
  if (rootMain) mains.add(rootMain);
  const loose = targets.filter((t) => t.type === 'bundle' || !mains.has(safeReal(t.path)));
  for (const t of loose) t.depth = path.relative(root, t.path).split(path.sep).length;
  loose.push({ path: root, type: 'bundle', main: rootMain, depth: 0 });
  // Deepest first; within a depth bundles come after files (irrelevant for correctness, stable for logs).
  return loose.sort((a, b) => b.depth - a.depth || (a.type === b.type ? (a.path < b.path ? -1 : 1) : a.type === 'file' ? -1 : 1));
}

function safeReal(p) { try { return fs.realpathSync(p); } catch { return p; } }

// ---- strict entitlement reader: empty output, an "invalid entitlements blob" warning or a non-plist result is an ERROR, never {}
export class EntitlementReadError extends Error {
  constructor(target, why, details) { super(`ENTITLEMENT_READ ${target}: ${why}`); this.name = 'EntitlementReadError'; this.code = 'ENTITLEMENT_READ'; this.details = { target, why, ...details }; }
}

/**
 * Minimal DER decoder for Apple's entitlements encoding: [APPLICATION 16] { INTEGER version, [CONTEXT 16] { SEQUENCE { UTF8String key, value }* } }
 * with BOOLEAN / INTEGER / UTF8String / SEQUENCE (array) / nested [CONTEXT 16] (dict) values. Throws on anything else.
 */
export function decodeEntitlementDer(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  // read one TLV at pos, which must end within `limit` (its parent's end)
  const read = (pos, limit) => {
    if (pos + 2 > limit) throw new Error('truncated DER (header)');
    const tag = buf[pos]; let len = buf[pos + 1]; let p = pos + 2;
    if (len & 0x80) {
      const n = len & 0x7f;
      if (n < 1 || n > 4) throw new Error('bad DER length form');
      if (p + n > limit) throw new Error('truncated DER (long-form length)');
      len = 0; for (let i = 0; i < n; i++) len = len * 256 + buf[p++];
      if (!Number.isSafeInteger(len)) throw new Error('DER length overflow');
    }
    if (p + len > limit) throw new Error('DER child overruns its parent');
    return { tag, start: p, end: p + len };
  };
  const integer = (body) => {
    if (body.length < 1 || body.length > 8) throw new Error('bad INTEGER length');
    let n = 0n; for (const x of body) n = n * 256n + BigInt(x);
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('INTEGER out of range');
    return Number(n);
  };
  const value = (pos, limit) => {
    const t = read(pos, limit);
    const body = buf.subarray(t.start, t.end);
    let v;
    if (t.tag === 0x01) { if (body.length !== 1) throw new Error('bad BOOLEAN'); v = body[0] !== 0; }
    else if (t.tag === 0x02) v = integer(body);
    else if (t.tag === 0x0c) v = body.toString('utf8');
    else if (t.tag === 0x30) { v = []; let q = t.start; while (q < t.end) { const r = value(q, t.end); v.push(r.v); q = r.next; } if (q !== t.end) throw new Error('SEQUENCE not fully consumed'); }
    else if (t.tag === 0xb0) {
      v = {}; let q = t.start;
      while (q < t.end) {
        const m = read(q, t.end); if (m.tag !== 0x30) throw new Error('dict member is not a SEQUENCE');
        const k = read(m.start, m.end); if (k.tag !== 0x0c) throw new Error('dict key is not a string');
        const val = value(k.end, m.end);
        if (val.next !== m.end) throw new Error('dict member not fully consumed');
        v[buf.subarray(k.start, k.end).toString('utf8')] = val.v; q = m.end;
      }
      if (q !== t.end) throw new Error('dict not fully consumed');
    } else throw new Error(`unsupported DER tag 0x${t.tag.toString(16)}`);
    return { v, next: t.end };
  };
  const top = read(0, buf.length);
  if (top.tag !== 0x70) throw new Error('not an entitlements DER (outer tag)');
  if (top.end !== buf.length) throw new Error('trailing bytes after the entitlements DER');
  const ver = read(top.start, top.end); if (ver.tag !== 0x02) throw new Error('missing DER version');
  if (integer(buf.subarray(ver.start, ver.end)) !== 1) throw new Error('unsupported entitlements DER version');
  const dict = value(ver.end, top.end);
  if (dict.next !== top.end) throw new Error('entitlements DER not fully consumed');
  if (!dict.v || typeof dict.v !== 'object' || Array.isArray(dict.v)) throw new Error('entitlements are not a dictionary');
  return dict.v;
}

function parsePlistXml(text, target) {
  const r = spawnSync(PLUTIL, ['-convert', 'json', '-o', '-', '-'], { input: text, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (r.status !== 0) throw new EntitlementReadError(target, `not a property list: ${String(r.stderr).trim().slice(0, 120)}`);
  let parsed; try { parsed = JSON.parse(r.stdout); } catch { throw new EntitlementReadError(target, 'plutil produced invalid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new EntitlementReadError(target, 'entitlements are not a dictionary');
  return parsed;
}

/** `hashes=<code>+<special>` of `codesign -dvvvv`: the number of special slots (-1 Info.plist … -5 entitlements … -7 DER entitlements). */
export const specialSlotCount = (stderr) => { const m = /hashes=\d+\+(\d+)/.exec(String(stderr)); return m ? Number(m[1]) : null; };

async function defaultRunBinary(cmd, args) {
  const r = spawnSync(cmd, args, { maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} failed: ${String(r.stderr).trim()}`);
  return { stdout: r.stdout, stderr: String(r.stderr) };
}

/**
 * The entitlements embedded in a signature, read strictly.
 *  1. `codesign -d --entitlements - --xml <t>`.
 *  2. empty stdout (with or without an "invalid entitlements" warning): fall back to `--entitlements - --der` (decoded in-process; plutil cannot read DER).
 *  3. still empty (an "invalid entitlements" warning is then an error): the executable has no entitlements ONLY if `codesign -dvvvv` shows fewer than 5 special slots
 *     (no -5 entitlements slot, no -7 DER slot) - or codesign says "not signed at all". Anything else is an error.
 * @returns {Promise<{ents: Record<string, unknown>, source: 'xml'|'der'|'none'|'unsigned'}>}
 */
export async function readEntitlementsStrict(target, run = defaultRun, { runBinary = run === defaultRun ? defaultRunBinary : run } = {}) {
  const fail = (why, d) => { throw new EntitlementReadError(target, why, d); };
  let xml;
  try { xml = await run(CODESIGN, ['-d', '--entitlements', '-', '--xml', target]); } catch (e) {
    if (/not signed at all/i.test(String(e.message))) return { ents: {}, source: 'unsigned' };
    return fail(`codesign failed: ${String(e.message).slice(0, 200)}`);
  }
  const stderr = String(xml.stderr ?? '');
  // an "invalid entitlements blob" warning with empty XML output is the macOS 27 behaviour for blobs only --der can read: fall through to DER
  const warned = /invalid entitlements/i.test(stderr);
  const out = String(xml.stdout ?? '');
  if (out.trim()) return { ents: parsePlistXml(out, target), source: 'xml' };
  let der;
  try { der = await runBinary(CODESIGN, ['-d', '--entitlements', '-', '--der', target]); } catch (e) { fail(`codesign --der failed: ${String(e.message).slice(0, 200)}`); }
  const derWarned = /invalid entitlements/i.test(String(der.stderr ?? ''));
  const derBytes = Buffer.isBuffer(der.stdout) ? der.stdout : Buffer.from(String(der.stdout ?? ''), 'latin1');
  if (derBytes.length) {
    if (derBytes.subarray(0, 64).toString('utf8').includes('<plist')) return { ents: parsePlistXml(derBytes.toString('utf8'), target), source: 'der' };
    try { return { ents: decodeEntitlementDer(derBytes), source: 'der' }; } catch (e) { fail(`undecodable DER entitlements: ${e.message}`); }
  }
  if (warned || derWarned) fail('codesign reports an invalid entitlements blob and neither --xml nor --der produced entitlements', { stderr: stderr.slice(0, 300) });
  let verbose;
  try { verbose = await run(CODESIGN, ['-d', '-vvvv', target]); } catch (e) { return fail(`codesign -dvvvv failed: ${String(e.message).slice(0, 200)}`); }
  const special = specialSlotCount(verbose.stderr);
  if (special !== null && special < 5) return { ents: {}, source: 'none' }; // explicit: the code directory has no entitlements slot
  return fail(special === null ? 'empty entitlements output and the code directory could not be inspected' : `empty entitlements output but the signature has ${special} special slots (an entitlements slot exists)`);
}

/** Entitlements currently embedded in a signature (strict; see readEntitlementsStrict). */
export async function readEntitlements(target, run = defaultRun, opts = {}) {
  return (await readEntitlementsStrict(target, run, opts)).ents;
}

async function defaultRun(cmd, args) {
  try { return await execFileP(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); } catch (e) {
    throw new Error(`${path.basename(cmd)} ${args.join(' ').slice(0, 300)} failed: ${String(e.stderr || e.stdout || e.message).trim()}`, { cause: e });
  }
}

function entitlementsPlist(dir, n, entitlements) {
  const file = path.join(dir, `ent-${n}.plist`);
  fs.writeFileSync(file, JSON.stringify(entitlements), { mode: 0o600 });
  const r = spawnSync(PLUTIL, ['-convert', 'xml1', file]);
  if (r.status !== 0) throw new Error(`plutil failed for entitlements: ${r.stderr}`);
  return file;
}

/**
 * Sign every code object under root with `identity` ('-' = ad-hoc), inside out, then verify.
 * @param {string} root the .app
 * @param {{identity: string, run?: Function, concurrency?: number, workDir?: string, log?: (m:string)=>void}} opts
 * @returns {Promise<{signed: number, targets: object[], verified: true}>}
 */
export async function signBundle(root, { identity, run = defaultRun, concurrency = 6, workDir, log = () => {}, appGroup = null, entitlementSourceRoot = null }) {
  if (!identity) throw new Error('signBundle: identity is required ("-" for ad-hoc)');
  const targets = listSigningTargets(root);
  const work = workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'codexmods-sign-'));
  fs.mkdirSync(work, { recursive: true, mode: 0o700 });
  const plans = [];
  try {
    // Read every entitlement set first: signing a bundle rewrites its main executable's signature.
    let n = 0;
    for (const t of targets) {
      const kind = t.type === 'bundle' ? (t.main ? machoKind(t.main) : null) : t.kind;
      const executable = kind === 'execute';
      // The binary patches rewrite bytes inside the embedded entitlements, which makes the blob of the PATCHED file invalid (codesign prints
      // nothing). The stock signature at the same relative path is the source of truth for what an executable was granted.
      const rel = path.relative(root, t.path) || '.';
      const stockPath = entitlementSourceRoot ? path.join(entitlementSourceRoot, rel) : null;
      const readFrom = stockPath && fs.existsSync(stockPath) ? stockPath : t.path;
      const source = (kind === 'execute') ? await readEntitlements(readFrom, run) : {};
      // the app's main executable always gets the team-matched group; a Computer Use helper executable only if its stock signature carried one
      const isMain = t.type === 'bundle' && path.resolve(t.path) === path.resolve(root);
      const inCua = `${t.path}${path.sep}`.includes(`${path.sep}Resources${path.sep}cua_node${path.sep}`);
      const holdsGroup = executable && (isMain || (inCua && Object.hasOwn(source, APP_GROUPS)));
      const giveGroup = appGroup && holdsGroup;
      const f = filterEntitlements(source, { identity, executable, appGroup: giveGroup ? appGroup : null });
      const plan = { ...t, executable, entitlements: f.entitlements, removed: f.removed, added: f.added, entitled: f.entitled, requiredGroup: holdsGroup };
      if (executable) plan.entitlementsFile = entitlementsPlist(work, n++, f.entitlements);
      plans.push(plan);
    }
    const byDepth = new Map();
    for (const p of plans) { if (!byDepth.has(p.depth)) byDepth.set(p.depth, []); byDepth.get(p.depth).push(p); }
    for (const depth of [...byDepth.keys()].sort((a, b) => b - a)) {
      const group = byDepth.get(depth);
      let i = 0;
      await Promise.all(Array.from({ length: Math.min(concurrency, group.length) }, async () => {
        while (i < group.length) {
          const p = group[i++];
          const args = ['--force', '--sign', identity, '--options', 'runtime', '--timestamp=none'];
          if (p.entitlementsFile) args.push('--entitlements', p.entitlementsFile);
          args.push(p.path);
          await run(CODESIGN, args);
        }
      }));
      log(`signed depth ${depth}: ${group.length}`);
    }
    await run(CODESIGN, ['--verify', '--deep', '--strict', root]);
  } finally {
    if (!workDir) fs.rmSync(work, { recursive: true, force: true });
  }
  return { signed: plans.length, verified: true, targets: plans.map((p) => ({ path: path.relative(root, p.path) || '.', type: p.type, removed: p.removed, added: p.added, entitled: p.entitled === true, requiredGroup: p.requiredGroup === true })),
    required: plans.filter((p) => p.requiredGroup).map((p) => path.relative(root, p.path) || '.').sort() };
}

export async function verifyBundle(root, run = defaultRun) {
  await run(CODESIGN, ['--verify', '--deep', '--strict', root]);
  return true;
}

// ---- post-sign checks (ARCHITECTURE v1.16)
/** TeamIdentifier of a signed code object (null for ad-hoc / unsigned). */
export async function readTeamIdentifier(target, run = defaultRun) {
  let err;
  try { err = (await run(CODESIGN, ['-dv', '--verbose=2', target])).stderr ?? ''; } catch (e) { err = String(e.message ?? ''); }
  const m = /^TeamIdentifier=(.+)$/m.exec(err)?.[1]?.trim();
  return !m || m === 'not set' ? null : m;
}

const TEAM_PREFIX = /^([A-Z0-9]{10})\./;
/**
 * Evaluate the entitlements actually embedded in the signed code objects: any app-group naming a team other than the signer's, and any
 * app group at all for an ad-hoc signer. Pure; `entitlements` is [{path, ents}].
 * @returns {{groups: Record<string, string[]>, mismatches: {path: string, group: string, why: string}[]}}
 */
export function evaluateSignedGroups(entitlements, signerTeam) {
  const groups = {}; const mismatches = [];
  for (const { path: p, ents } of entitlements) {
    const list = ents?.[APP_GROUPS];
    if (list === undefined) continue;
    const arr = Array.isArray(list) ? list : [list];
    groups[p] = arr.map(String);
    for (const g of arr.map(String)) {
      const team = TEAM_PREFIX.exec(g)?.[1];
      if (!signerTeam) mismatches.push({ path: p, group: g, why: 'an ad-hoc signature must not carry an app group' });
      else if (team && team !== signerTeam) mismatches.push({ path: p, group: g, why: `names team ${team}, the signer is ${signerTeam}` });
      else if (!team) mismatches.push({ path: p, group: g, why: 'not team-prefixed' });
    }
  }
  return { groups, mismatches };
}

/** Dump the signed entitlements of every code object under root (`codesign -d --entitlements :-`). */
export async function dumpSignedEntitlements(root, relPaths, run = defaultRun) {
  const out = [];
  for (const rel of relPaths) {
    const p = rel === '.' ? root : path.join(root, rel);
    out.push({ path: rel, ents: await readEntitlements(p, run) });
  }
  return out;
}
