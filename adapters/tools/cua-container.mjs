// Computer Use container isolation. The bundled managed helper (`SkyComputerUseService`, started by the app's main process as
// soon as any of Computer Use / Appshots / Skysight is available for the account) works in the STOCK app's Group Container
// `~/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/` (IPC/computeruse.sock, Application Support/Software/*), and its lock-screen
// IPC uses `/tmp/com.openai.sky.CUAService/`. Those names are string literals in the helper binaries, the app's main bundle, node_repl and the
// cua/sky JS packages. This module derives a consistent same-length rename (last character e → f) of exactly those literals:
//   - the team-prefixed container id and the /tmp lock-screen directory, wherever they occur OUTSIDE a code signature (signatures are rewritten by
//     the builder's re-sign anyway);
//   - the BARE bundle identifier `com.openai.sky.CUAService` (the helper's bundle id / preferences domain) too: the copy gets its OWN helper identity.
// The asar edits (`deriveCuaContainerTransform`) locate every site by string anchors and structure, never by a minified or chunk name; their ids and files are by role.
// Fails closed: it reports `missing` unless the expected helper sites exist, and every patch is exact bytes with whole-file hashes.
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { sha256, applyBinaryPatch } from './binary-patch.mjs';
import { applyOp, fileStem, findMainBundle, isMainBundle } from './transform.mjs';
import { shapeOf } from './js-shape.mjs';

export const GROUP = '2DC432GLL2.com.openai.sky.CUAService';
export const TMP_DIR = '/tmp/com.openai.sky.CUAService';
/** The helper's bundle identifier / preferences domain. Renamed too: the copy gets its OWN helper identity, so LaunchServices, `defaults`
 *  and Apple events can never resolve to the stock helper. */
export const BARE = 'com.openai.sky.CUAService';
export const rename = (s) => `${s.slice(0, -1)}f`;                 // …CUAService → …CUAServicf (same length)
const NEEDLES = [GROUP, TMP_DIR, BARE];

/** node-side helper client (`native-pipe.js`, two identical copies): same-length edits that stop it from finding the STOCK helper.
 *  1. it reads the helper path from env SKY_CUA_SERVICE_PATH → a distinct variable name, the same one the app's main bundle exports (R2-1, "own config key");
 *  2. when that is unset it looks in `<CODEX_HOME>/computer-use/Codex Computer Use.app` (the shared ~/.codex of a daily profile) → a name that never exists;
 *  3. then it launches by bundle id: renamed above via BARE, so LaunchServices can only find the copy's own helper. */
export const SERVICE_PATH_ENV = 'SKY_CUA_SERVICE_PATH';
export const SERVICE_PATH_ENV_COPY = 'SKY_CUA_SERVICE_PATM';
export const NATIVE_PIPE_EDITS = Object.freeze([
  { key: 'service-path-env', before: '?void 0:e.SKY_CUA_SERVICE_PATH)', after: '?void 0:e.SKY_CUA_SERVICE_PATM)' },
  { key: 'codex-home-fallback', before: '.join(n,"computer-use","Codex Computer Use.app")', after: '.join(n,"computer-usf","Codex Computer Use.app")' },
]);
const isNativePipe = (rel) => /mac\/native-pipe\.js$/.test(rel);
const SKIP = (p) => /\.provisionprofile$/.test(p) || /BUILD\.bazel$/.test(p);   // inert text/profile files: not read at runtime

/** Byte ranges of every code signature blob in a (possibly fat) Mach-O; [] for anything else. */
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

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) yield* walk(p); else if (e.isFile()) yield p;
  }
}

/** Occurrences of the needles outside code signatures. @returns {{ needle: string, offset: number }[]} */
export function findSites(buf) {
  const sig = signatureRanges(buf);
  const out = [];
  for (const needle of NEEDLES) {
    const nb = Buffer.from(needle);
    for (let i = buf.indexOf(nb); i >= 0; i = buf.indexOf(nb, i + 1)) if (!sig.some(([a, b]) => i >= a && i < b)) out.push({ needle, offset: i });
  }
  // The bare bundle id is a suffix of the other two names: a hit inside one of those is already covered by that rename.
  const spans = out.filter((o) => o.needle !== BARE).map((o) => [o.offset, o.offset + o.needle.length]);
  return out.filter((o) => o.needle !== BARE || !spans.some(([a, b]) => o.offset >= a && o.offset < b)).sort((a, b) => a.offset - b.offset);
}

/** Exact-text sites of the native-pipe edits (each must occur exactly once per file). */
export function findNativePipeSites(buf) {
  return NATIVE_PIPE_EDITS.map((e) => {
    const nb = Buffer.from(e.before); const hits = [];
    for (let i = buf.indexOf(nb); i >= 0; i = buf.indexOf(nb, i + 1)) hits.push(i);
    return { ...e, offsets: hits };
  });
}

/**
 * binaryPatches for every real occurrence under `<Contents>/Resources/cua_node` (the helper app, node_repl and the cua/sky packages; a scan of the
 * whole bundle found no other behavioural site). `roots` is overridable for tests. Chained per file; files in sorted order.
 */
export function deriveCuaContainerPatches(contents, { roots = ['Resources/cua_node'] } = {}) {
  const patches = [];
  const byFile = new Map();
  const nativeProblems = [];
  for (const root of roots) {
    const dir = join(contents, root);
    try { lstatSync(dir); } catch { continue; }
    for (const file of walk(dir)) {
      const rel = relative(contents, file);
      if (SKIP(rel)) continue;
      const buf = readFileSync(file);
      const sites = findSites(buf).map((x) => ({ before: Buffer.from(x.needle), after: Buffer.from(rename(x.needle)), offset: x.offset, what: x.needle === GROUP ? 'Group Container' : x.needle === TMP_DIR ? 'lock-screen IPC directory' : 'bundle identifier / preferences domain' }));
      if (isNativePipe(rel)) {
        for (const e of findNativePipeSites(buf)) {
          if (e.offsets.length !== 1) { nativeProblems.push(`${rel}: "${e.key}" occurs ${e.offsets.length} times, expected exactly 1`); continue; }
          sites.push({ before: Buffer.from(e.before), after: Buffer.from(e.after), offset: e.offsets[0], what: e.key === 'service-path-env' ? 'helper path variable (distinct from SKY_CUA_SERVICE_PATH)' : 'CODEX_HOME helper fallback' });
        }
        sites.sort((a, b) => a.offset - b.offset);
      }
      if (sites.length) byFile.set(rel, { buf, sites });
    }
  }
  const files = [...byFile.keys()].sort();
  const has = (suffix, needle, n = 1) => files.some((f) => f.endsWith(suffix) && byFile.get(f).sites.filter((s) => s.before.toString() === needle).length >= n);
  const missing = [];
  for (const [suffix, needle, n] of [['MacOS/SkyComputerUseService', GROUP, 1], ['MacOS/SkyComputerUseService', TMP_DIR, 1], ['MacOS/SkyComputerUseService', BARE, 1], ['MacOS/SkyComputerUseClient', GROUP, 1], ['MacOS/SkyComputerUseClient', BARE, 1], ['bin/node_repl', GROUP, 1], ['mac/native-pipe.js', GROUP, 1], ['mac/native-pipe.js', BARE, 1], ['Codex Computer Use.app/Contents/Info.plist', BARE, 1]]) {
    if (!has(suffix, needle, n)) missing.push({ item: `binaryPatches:cua-container:${basename(suffix)}`, mandatory: true, tried: `no "${needle}" outside the code signature in a file ending ${suffix} under ${roots.join(', ')}` });
  }
  for (const m of nativeProblems) missing.push({ item: 'binaryPatches:cua-container:native-pipe.js', mandatory: true, tried: m });
  if (!files.some((f) => isNativePipe(f))) missing.push({ item: 'binaryPatches:cua-container:native-pipe.js', mandatory: true, tried: 'no native-pipe.js' });
  if (missing.length) return { patches: [], missing };
  for (const rel of files) {
    const { buf, sites } = byFile.get(rel);
    let cur = buf; let hash = sha256(buf);
    sites.forEach((s, i) => {
      const p = { id: `cua-container:${rel.replace('Resources/cua_node/', '')}:${i + 1}`, file: rel, sha256Before: hash, offset: s.offset, before: s.before.toString('hex'), after: s.after.toString('hex'), sha256After: '',
        justification: `Computer Use isolation: "${s.before.toString()}" → "${s.after.toString()}" (${s.what}) so the copy's own helper, node_repl and cua packages never use the stock app's helper identity, container or lock-screen directory` };
      cur = applyBinaryPatch(cur, p, { checkAfter: false });
      p.sha256After = sha256(cur); hash = p.sha256After;
      patches.push(p);
    });
  }
  return { patches, missing: [] };
}

/** Environment variable framework-main sets (to layout.computerUse) before the app starts: the directory the copy's own helper is installed in. */
export const COMPUTER_USE_DIR_ENV = 'CODEX_MODS_COMPUTER_USE_DIR';

const ID = '[A-Za-z_$][\\w$]*';
// Two minifiers' spellings of the same code: 21477 writes template literals, names single-use constants and calls the path module as
// `X.default.join`; 22943 writes quoted strings, inlines single-use constants and calls `X().join` (webpack's default-interop getter) or
// `(0,X.join)`. A site is matched in either spelling, and its edit is written in the build's own (the callee as it is written there).
const Q = '[`"\']';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lit = (s) => `${Q}${esc(s)}${Q}`;
/** A call of a path function in any spelling: `X.default.fn`, `X().fn`, `(0,X.fn)`. */
const PATH_FN = (fn) => `(?:${ID}\\.default\\.${fn}|${ID}\\(\\)\\.${fn}|\\(0,${ID}\\.${fn}\\))`;
/**
 * The text of the webpack module that holds offset `at` in a chunk (22943: `exports.modules={<id>(e,t,r){…},<id>(…){…}}`, whose modules reuse
 * the same short names), else the whole text (21477's single bundle): a minified name is counted only in its own module.
 */
export function moduleText(text, at) {
  if (!/^\s*exports\.ids=/.test(text.slice(0, 64))) return text;
  const head = /[{,](\d+)\((?:[A-Za-z_$][\w$]*(?:,[A-Za-z_$][\w$]*)*)?\)\{/g;
  let from = 0, to = text.length;
  for (const m of text.matchAll(head)) { if (m.index <= at) from = m.index; else { to = m.index; break; } }
  return text.slice(from, to);
}
let shaped = { text: null, shape: null };   // the last bundle parsed (the main bundle: parsed once per derivation)
/**
 * How many identifiers name the function declared at `at` (its declaration included), resolved through scopes: a text count would also
 * count another module's function of the same short name, or `A-Fa-f` in a regular expression (22943). -1 when the bundle does not parse
 * or no function of that name is declared there.
 */
export function boundUses(text, name, at) {
  if (shaped.text !== text) shaped = { text, shape: shapeOf(text) };
  const s = shaped.shape;
  if (!s) return -1;
  const decl = s.nodes.find((n) => n.type === 'FunctionDeclaration' && n.start === at && n.id?.name === name);
  if (!decl) return -1;
  return s.nodes.filter((n) => n.type === 'Identifier' && n.name === name && s.binding(n)?.init === decl).length;
}
/** The role a file's sites are numbered under: the main bundle (the one that starts the helper), another main-process chunk, a worker. */
const roleOf = (file, mainFile) => (file === mainFile ? 'main' : isMainBundle(file) ? 'src' : /^\.vite\/build\/worker(?:-[^/]*)?\.js$/.test(file) ? 'worker' : fileStem(file));

/**
 * Asar transforms for the app's main bundle and sibling chunks (all mandatory; fail closed with `missing` entries):
 *  - `cua-relocate-dir`   `Da(codexHome)` (= `<CODEX_HOME>/computer-use/Codex Computer Use.app`) is the ONE place the canonical helper directory is computed; it is used by
 *                          `Oie` (remove + `ditto` refresh of the helper), by the service-path discovery that feeds node_repl, and by `new kie(Da(codexHome))` (spawn + process check).
 *                          It now returns `$CODEX_MODS_COMPUTER_USE_DIR/Codex Computer Use.app`, and a never-stock fallback (`<CODEX_HOME>/computer-use-codexmods`) if the variable is unset.
 *  - `cua-relocate-config` the helper's overlay config writer `kc → Fc → Ic` joined `<CODEX_HOME>/computer-use/config.json`; `Fc` now writes `$CODEX_MODS_COMPUTER_USE_DIR/config.json`
 *                          (same directory and same never-stock fallback as `cua-relocate-dir`).
 *  - `cua-relocate-installer` `Vhe()` (the locked-use installer binary run by `cT()` for status/install/uninstall) joined codexHome with `Phe` (`computer-use/Codex Computer Use.app/…/Codex Computer Use Installer`);
 *                          it now joins the relocated directory with `Phe` minus its first element, i.e. the same `Codex Computer Use.app` that `cua-relocate-dir` names.
 *  - `cua-disable-locked-use` Locked use is unavailable in the copy (ARCHITECTURE v1.15): its installer changes SYSTEM-wide state shared with stock (`/Library/Security/SecurityAgentPlugins/CodexComputerUseAuthorizationPlugin.bundle`,
 *                          `/Library/Application Support/CodexComputerUseAuthorizationPlugin`, the `system.login.screensaver` rule). `cT()` (the only function that executes the installer, for status/install/uninstall), `sT()` (status)
 *                          and `Bhe()` (install/uninstall) are replaced by the app's own "unsupported" result (`null`, what a non-darwin platform returns), so `getLockedUseState` reports `enabled: null` (the settings row is not rendered)
 *                          and `setLockedUseEnabled` resolves `null` (no toast); nothing is spawned. `cT` throws if anything else ever reaches it.
 *  - `cua-helper-private-home` (ARCHITECTURE v1.21) the managed service is started by `pd()` = `Xu(…).spawnComputerUseService(path)` (native addon `Resources/native/sky.node`: `posix_spawn` with the live `*_NSGetEnviron()`,
 *                          disclaimed responsibility), so the helper inherits the app's `CODEX_HOME` (shared ~/.codex) and rewrites the shared `notify`. `pd()` now sets `process.env.CODEX_HOME` to
 *                          `dirname($CODEX_MODS_COMPUTER_USE_DIR)` (the profile dir; the helper's `computer-use/config.json` is then exactly the file `cua-relocate-config` writes) around the synchronous
 *                          spawn call and restores it in `finally`; unchanged when the variable is unset.
 *                          CORRECTION (native finding): the addon's spawn is a Napi AsyncWorker (posix_spawn runs later on a worker thread), so the value is held until the child exists (see below).
 *  - `cua-relocate-approvals` `Hw(e)` (win32-only legacy TOML approvals migration) read and rewrote `dirname(<CODEX_HOME>/config.toml)/computer-use/config.toml`; it now uses the relocated directory.
 *                          Unreachable on macOS (the approvals store there is the renamed Group Container), relocated anyway so no `computer-use` path of the bundle derives from CODEX_HOME.
 *  - `cua-service-path-env` the env variable the app exports to node_repl and reads from process.env (`SKY_CUA_SERVICE_PATH`) gets a distinct name, so an ambient/stock value is ignored.
 *  - `cua-container`      the Group Container id constant.
 *  - `cua-bundle-id:*`    every remaining bare bundle id (ignore lists, the preferences domain for computerUseSoundMode, the Apple-event target, the native bridge).
 */
export function deriveCuaContainerTransform(source) {
  const miss = (tried) => ({ drafts: [], missing: [{ item: 'transform:cua-container', mandatory: true, tried }] });
  const chunks = source.list('.vite/build/').filter((p) => p.endsWith('.js')).map((file) => ({ file, text: source.read(file) }));
  const web = source.list('webview/assets/').filter((p) => p.endsWith('.js') && source.size(p) > 20_000).filter((p) => { const t = source.read(p); return t.includes(BARE) || t.includes(SERVICE_PATH_ENV); });
  if (web.length) return miss(`renderer chunks mention the helper (${web.length}); the locators only cover .vite/build`);
  const countIn = (needle) => chunks.flatMap((c) => { const r = []; for (let i = c.text.indexOf(needle); i >= 0; i = c.text.indexOf(needle, i + 1)) r.push({ ...c, i }); return r; });

  // container id constant
  const groupHits = countIn(GROUP);
  if (groupHits.length !== 1) return miss(`"${GROUP}" occurs ${groupHits.length} times in .vite/build, expected exactly 1`);
  const main = groupHits[0];
  // the main bundle is a ROLE (`.vite/build/main-*.js` that starts the helper and names the container), never a file name: names carry a content hash
  const mainRole = findMainBundle(source, ['spawnComputerUseService(', GROUP]);
  if (mainRole.error || mainRole.file !== main.file) return miss(`the container id is not in the main bundle that starts the helper (${mainRole.error ?? `${main.file} is not ${mainRole.file}`})`);
  const gm = new RegExp(`(?:${ID}=)?(${Q})${esc(GROUP)}\\1`).exec(main.text.slice(Math.max(0, main.i - 40), main.i + GROUP.length + 2));
  if (!gm || !gm[0].endsWith(`${GROUP}${gm[1]}`)) return miss('the container id is not a complete string literal');
  const drafts = [];

  // canonical helper dir
  const re = new RegExp(`function (${ID})\\((${ID})\\)\\{return (${PATH_FN('join')})\\(\\2,${lit('computer-use')},(${ID})\\)\\}`, 'g');
  const dirs = [...main.text.matchAll(re)];
  if (dirs.length !== 1 || !new RegExp(`[,; ]${dirs[0]?.[4].replace('$', '\\$')}=${lit('Codex Computer Use.app')}`).test(main.text)) return miss(`the canonical helper directory function occurs ${dirs.length} times in the main bundle (expected exactly 1, joined with the "Codex Computer Use.app" constant)`);
  const [dm, fn, arg, join, appConst] = dirs[0];
  drafts.push({ id: 'cua-relocate-dir', seam: 'other', file: main.file, op: 'replace-once', find: dm,
    text: `function ${fn}(${arg}){let m=process.env.${COMPUTER_USE_DIR_ENV};return m?${join}(m,${appConst}):${join}(${arg},\`computer-use-codexmods\`,${appConst})}`,
    why: `Computer Use relocation: the helper is installed, refreshed, discovered and spawned from $${COMPUTER_USE_DIR_ENV} (set by framework-main to layout.computerUse), never from <CODEX_HOME>/computer-use` });

  // helper overlay config: kc -> Fc -> Ic writes <dir>/config.json
  // the "computer-use" segment is a constant (21477) or inline (22943); the writer is a named function, or (25679, whose minifier inlines
  // single-use functions) an anonymous function expression called where it is used
  const cfgRe = new RegExp(`async function(?: (${ID}))?\\(\\{codexHome:(${ID}),config:(${ID})\\}\\)\\{let (${ID})=(${PATH_FN('join')})\\(\\2,(${ID}|${lit('computer-use')})\\),(${ID})=${PATH_FN('join')}\\(\\4,(${ID})\\),`, 'g');
  const cfgs = [...main.text.matchAll(cfgRe)];
  const segConst = cfgs.length === 1 && !new RegExp(`^${Q}`).test(cfgs[0][6]);
  const cfgOk = cfgs.length === 1 && (!segConst || new RegExp(`[,; ]${cfgs[0][6].replaceAll('$', '\\$')}=${lit('computer-use')}`).test(main.text)) && new RegExp(`[,; ]${cfgs[0][8].replaceAll('$', '\\$')}=${lit('config.json')}`).test(main.text);
  if (!cfgOk) return miss(`the Computer Use config writer (join(codexHome, "computer-use"), "config.json") occurs ${cfgs.length} times in the main bundle (expected exactly 1 with the "config.json" constant)`);
  const [, cfn, carg, cconf, cdir, cjoin, cseg] = cfgs[0];
  const cfgScope = moduleText(main.text, cfgs[0].index);
  if (segConst && countUses(cfgScope, cseg) !== 2) return miss(`the "computer-use" segment constant ${cseg} is used ${countUses(cfgScope, cseg) - 1} times (expected only by the config writer)`);
  const cfnHead = `async function${cfn ? ` ${cfn}` : ''}`;
  const cfgFind = `${cfnHead}({codexHome:${carg},config:${cconf}}){let ${cdir}=${cjoin}(${carg},${cseg})`;
  drafts.push({ id: 'cua-relocate-config', seam: 'other', file: main.file, op: 'replace-once', find: cfgFind,
    text: `${cfnHead}({codexHome:${carg},config:${cconf}}){let ${cdir}=process.env.${COMPUTER_USE_DIR_ENV}||${cjoin}(${carg},\`computer-use-codexmods\`)`,
    why: `Computer Use relocation: the helper's overlay config (config.json) is written to $${COMPUTER_USE_DIR_ENV} (the directory of cua-relocate-dir), never to <CODEX_HOME>/computer-use` });

  // locked-use installer: Vhe() = join(codexHome, ...Phe) run by cT() (status / install / uninstall)
  // the installer path array `K=["computer-use","Codex Computer Use.app",…,"Codex Computer Use Installer"]`, used once: by a resolver function
  // (21477: `function F(){return X.default.join(home(),...K)}`, replaced whole) or inline in the executor (22943: the join itself is replaced)
  const arrs = [...main.text.matchAll(new RegExp(`[,; ](${ID})=\\[${lit('computer-use')},${lit('Codex Computer Use.app')},`, 'g'))];
  if (arrs.length !== 1) return miss(`the locked-use installer path array (["computer-use","Codex Computer Use.app",…]) occurs ${arrs.length} times in the main bundle (expected exactly 1)`);
  const iarr = arrs[0][1];
  const insScope = moduleText(main.text, arrs[0].index);
  if (countUses(insScope, iarr) !== 2) return miss(`the installer path array ${iarr} is used ${countUses(insScope, iarr) - 1} times (expected only by the resolver)`);
  const insFn = [...main.text.matchAll(new RegExp(`function (${ID})\\(\\)\\{return (${PATH_FN('join')})\\((${ID}\\.${ID})\\(\\),\\.\\.\\.${iarr.replaceAll('$', '\\$')}\\)\\}`, 'g'))];
  const insInline = [...main.text.matchAll(new RegExp(`(${PATH_FN('join')})\\(((?:\\(0,${ID}\\.${ID}\\)|${ID}\\.${ID})\\(\\)),\\.\\.\\.${iarr.replaceAll('$', '\\$')}\\)`, 'g'))];
  if (insFn.length === 1) {
    const [im, ifn, ijoin, ihome] = insFn[0];
    drafts.push({ id: 'cua-relocate-installer', seam: 'other', file: main.file, op: 'replace-once', find: im,
      text: `function ${ifn}(){let m=process.env.${COMPUTER_USE_DIR_ENV};return m?${ijoin}(m,...${iarr}.slice(1)):${ijoin}(${ihome}(),\`computer-use-codexmods\`,...${iarr}.slice(1))}`,
      why: `Computer Use relocation: the installer (status/install/uninstall) and the bundle it manages resolve under $${COMPUTER_USE_DIR_ENV}/Codex Computer Use.app (the directory of cua-relocate-dir), never under <CODEX_HOME>/computer-use` });
  } else if (insInline.length === 1) {
    const [im, ijoin, ihome] = insInline[0];
    drafts.push({ id: 'cua-relocate-installer', seam: 'other', file: main.file, op: 'replace-once', find: im,
      text: `(process.env.${COMPUTER_USE_DIR_ENV}?${ijoin}(process.env.${COMPUTER_USE_DIR_ENV},...${iarr}.slice(1)):${ijoin}(${ihome},\`computer-use-codexmods\`,...${iarr}.slice(1)))`,
      why: `Computer Use relocation: the installer (status/install/uninstall) and the bundle it manages resolve under $${COMPUTER_USE_DIR_ENV}/Codex Computer Use.app (the directory of cua-relocate-dir), never under <CODEX_HOME>/computer-use` });
  } else return miss(`the locked-use installer resolver (join(codexHome(), ...${iarr})) occurs ${insFn.length} times as a function and ${insInline.length} times inline in the main bundle (expected exactly 1)`);

  // Locked use: Bhe(install|uninstall) / sT() (status) / cT(arg) (execFile of the installer) are adjacent; Rhe/getLockedUseState/setLockedUseEnabled are their only callers
  const lkRe = new RegExp(`async function (${ID})\\((${ID})\\)\\{return process\\.platform===\`darwin\`\\?\\(await (${ID})\\(\\2\\?\`install\`:\`uninstall\`\\),(${ID})\\(\\)\\):null\\}async function \\4\\(\\)\\{return\\(await \\3\\(\`status\`\\)\\)\\.trim\\(\\)===\`OK: installed\`\\}async function \\3\\((${ID})\\)\\{let\\{stdout:(${ID})\\}=await (${ID})\\((${ID})\\(\\),\\[\\5\\],\\{env:[^{}]*?timeout:12e4\\}\\);return \\6\\}`, 'g');
  // 22943: Yoda comparisons, and the installer path inlined in the executor (cua-relocate-installer edits it): the find ends at the executor's call
  const lkRe2 = new RegExp(`async function (${ID})\\((${ID})\\)\\{return${lit('darwin')}!==process\\.platform\\?null:\\(await (${ID})\\(\\2\\?${lit('install')}:${lit('uninstall')}\\),(${ID})\\(\\)\\)\\}async function \\4\\(\\)\\{return${lit('OK: installed')}===\\(await \\3\\(${lit('status')}\\)\\)\\.trim\\(\\)\\}async function \\3\\((${ID})\\)\\{let\\{stdout:(${ID})\\}=await (${ID})\\(`, 'g');
  // 25679: the minifier inlines single-use functions, so install/uninstall sits inline in setLockedUseEnabled and the status reader inline in getLockedUseState;
  // the adjacent group is the status function and the executor. The executor now returns null before it runs anything, so the status reads null (the row is
  // hidden) and install/uninstall resolves null (no toast); nothing else may call either (counted by binding).
  const lkRe3 = new RegExp(`async function (${ID})\\(\\)\\{return${lit('OK: installed')}===\\(await (${ID})\\(${lit('status')}\\)\\)\\.trim\\(\\)\\}async function \\2\\((${ID})\\)\\{let\\{stdout:(${ID})\\}=await (${ID})\\(`, 'g');
  const lks = [...main.text.matchAll(lkRe)], lks2 = [...main.text.matchAll(lkRe2)];
  const lks3 = lks.length + lks2.length ? [] : [...main.text.matchAll(lkRe3)];   // the older shapes contain this one: only when neither is there
  const lkCount = lks.length + lks2.length + lks3.length;
  if (lkCount !== 1) return miss(`the locked-use status/install/uninstall functions (sT/Bhe/cT, the only executors of the installer) occur ${lkCount} times in the main bundle (expected exactly 1 adjacent group)`);
  const lockedWhy = 'Locked use is unavailable in the copy: its installer changes system-wide state shared with stock (SecurityAgentPlugins bundle, Application Support plugin dir, system.login.screensaver rule). Status and install/uninstall return null (the non-darwin "unsupported" result the settings already handle: row hidden, no toast); the installer is never executed';
  if (lks3.length) {
    const lk = lks3[0];
    const [lkm, sT, cT, earg, eout, eexec] = lk;
    const lkScope = moduleText(main.text, lk.index);
    const notDarwin = `(?:process\\.platform!==${lit('darwin')}|${lit('darwin')}!==process\\.platform)`;
    const callers = [
      new RegExp(`async getLockedUseState\\(\\)\\{let\\[(${ID}),(${ID})\\]=await Promise\\.all\\(\\[async function\\(\\)\\{if\\(${notDarwin}\\)return null;try\\{return await ${sT.replaceAll('$', '\\$')}\\(\\)\\}catch\\{return!1\\}\\}\\(\\),async function\\(\\)\\{if\\(${notDarwin}\\)return\\{computerIconDataURL:null,lockIconDataURL:null\\};[^]{0,400}?\\}\\(\\)\\]\\);return\\{enabled:\\1,\\.\\.\\.\\2\\}\\}`),
      new RegExp(`setLockedUseEnabled\\((${ID})\\)\\{return async function\\((${ID})\\)\\{return ?${notDarwin}\\?null:\\(await ${cT.replaceAll('$', '\\$')}\\(\\2\\?${lit('install')}:${lit('uninstall')}\\),${sT.replaceAll('$', '\\$')}\\(\\)\\)\\}\\(\\1\\)\\}`),
    ].map((r) => r.exec(lkScope));
    if (callers.some((c) => !c)) return miss('the locked-use callers (the status reader inline in getLockedUseState, install/uninstall inline in setLockedUseEnabled) do not have the expected shape: the "unsupported" result would not flow to the UI');
    for (const [name, n] of [[sT, 3], [cT, 3]]) {
      const used = boundUses(main.text, name, main.text.indexOf(`async function ${name}(`, lk.index));
      if (used !== n) return miss(`${name} has other callers than the locked-use functions (${used} uses, expected ${n}: its declaration and the known callers)`);
    }
    drafts.push({ id: 'cua-disable-locked-use', seam: 'other', file: main.file, op: 'replace-once', find: lkm,
      text: `async function ${sT}(){return null}async function ${cT}(${earg}){return null;let{stdout:${eout}}=await ${eexec}(`,
      why: lockedWhy });
  } else {
    const lk = lks[0] ?? lks2[0];
    const [lkm, bhe, , cT, sT] = lk;
    const lkScope = moduleText(main.text, lk.index);
    const callers = [
      new RegExp(`async function (${ID})\\(\\)\\{if\\((?:process\\.platform!==${lit('darwin')}|${lit('darwin')}!==process\\.platform)\\)return null;try\\{return await ${sT.replaceAll('$', '\\$')}\\(\\)\\}catch\\{return!1\\}\\}`),
      new RegExp(`async getLockedUseState\\(\\)\\{let\\[e,t\\]=await Promise\\.all\\(\\[(${ID})\\(\\),(${ID})\\(\\)\\]\\);return\\{enabled:e,\\.\\.\\.t\\}\\}setLockedUseEnabled\\(e\\)\\{return ${bhe.replaceAll('$', '\\$')}\\(e\\)\\}`),
    ].map((r) => r.exec(lkScope));
    if (callers.some((c) => !c) || callers[1][1] !== callers[0][1]) return miss('the locked-use callers (status reader, getLockedUseState, setLockedUseEnabled) do not have the expected shape: the "unsupported" result would not flow to the UI');
    // each name counted where it is bound: its declaration and the known callers only
    for (const [name, n] of [[bhe, 2], [sT, 3], [cT, 3]]) {
      const at = main.text.indexOf(`async function ${name}(`, lk.index);
      const used = boundUses(main.text, name, at);
      if (used !== n) return miss(`${name} has other callers than the locked-use functions (${used} uses, expected ${n}: its declaration and the known callers)`);
    }
    if (lks.length) {
      drafts.push({ id: 'cua-disable-locked-use', seam: 'other', file: main.file, op: 'replace-once', find: lkm,
        text: `async function ${bhe}(e){return null}async function ${sT}(){return null}async function ${cT}(e){throw Error(\`Locked use is unavailable in this copy\`)}`,
        why: lockedWhy });
    } else {
      const [, , , , , earg, eout, eexec] = lk;
      drafts.push({ id: 'cua-disable-locked-use', seam: 'other', file: main.file, op: 'replace-once', find: lkm,
        text: `async function ${bhe}(e){return null}async function ${sT}(){return null}async function ${cT}(${earg}){throw Error(\`Locked use is unavailable in this copy\`);let{stdout:${eout}}=await ${eexec}(`,
        why: lockedWhy });
    }
  }

  // helper start: pd(path) is the only place the app starts the managed Computer Use service (default spawnService of the managed-service class)
  const pdRe = new RegExp(`async function (${ID})\\((${ID}),\\{addon:(${ID}),electronAppPath:(${ID})=(${ID})\\.app\\.getAppPath\\(\\),platform:(${ID})=process\\.platform,resourcesPath:(${ID})=process\\.resourcesPath\\}=\\{\\}\\)\\{return ?(?:\\6!==${lit('darwin')}|${lit('darwin')}!==\\6)\\|\\|(?:\\2\\.trim\\(\\)===${Q}${Q}|${Q}${Q}===\\2\\.trim\\(\\))\\?null:\\(\\3\\?\\?(${ID})\\(\\{electronAppPath:\\4,resourcesPath:\\7\\}\\)\\)\\.spawnComputerUseService\\(\\2\\)\\}`, 'g');
  const pds = [...main.text.matchAll(pdRe)];
  if (pds.length !== 1 || countIn('spawnComputerUseService(').length !== 1 || countIn('SkyComputerUseService').length !== 1) return miss(`the managed Computer Use service start (spawnComputerUseService) is not the single known site: ${pds.length} start function(s), ${countIn('spawnComputerUseService(').length} call(s), ${countIn('SkyComputerUseService').length} executable name(s)`);
  const [pm, pfn, parg, padd, pelec, pelecDef, pplat, pres, pxu] = pds[0];
  // `spawnComputerUseService` is a Napi AsyncWorker: it returns a promise and runs posix_spawn(…, *_NSGetEnviron()) LATER on a libuv worker thread (SpawnComputerUseServiceWorker::Execute).
  // A swap of process.env.CODEX_HOME that is restored when the call returns is therefore gone before the spawn happens. The swap has to stay in place until the
  // child exists, and nothing else may read the swapped value meanwhile: so the calling thread blocks (Atomics.wait, no JS runs) until pgrep sees the new child (bounded), then restores.
  const swap = `let mods=process.env.${COMPUTER_USE_DIR_ENV},addon=${padd}??${pxu}({electronAppPath:${pelec},resourcesPath:${pres}});if(!mods)return addon.spawnComputerUseService(${parg});`
    + 'let home=process.env.CODEX_HOME,cp=require(`child_process`),kids=()=>{try{return new Set(cp.execFileSync(`/usr/bin/pgrep`,[`-P`,String(process.pid),`-f`,`/MacOS/SkyComputerUseService`],{encoding:`utf8`,stdio:[`ignore`,`pipe`,`ignore`]}).split(`\\n`).filter(Boolean))}catch{return new Set}},before=kids(),started;'
    + 'process.env.CODEX_HOME=require(`path`).dirname(mods);try{started=addon.spawnComputerUseService(' + '${ARG}' + ');let gate=new Int32Array(new SharedArrayBuffer(4));for(let t0=Date.now();Date.now()-t0<500;){Atomics.wait(gate,0,0,10);if([...kids()].some(x=>!before.has(x)))break}}'
    + 'finally{if(home==null)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=home}return started}';
  drafts.push({ id: 'cua-helper-private-home', seam: 'other', file: main.file, op: 'replace-once', find: pm,
    text: `async function ${pfn}(${parg},{addon:${padd},electronAppPath:${pelec}=${pelecDef}.app.getAppPath(),platform:${pplat}=process.platform,resourcesPath:${pres}=process.resourcesPath}={}){if(${pplat}!==\`darwin\`||${parg}.trim()===\`\`)return null;${swap.replaceAll('${ARG}', parg)}`,
    why: `Computer Use isolation: the helper is posix_spawned (by the native addon, asynchronously on a worker thread, with the live environment) with CODEX_HOME = the profile directory (dirname of $${COMPUTER_USE_DIR_ENV}), so it no longer rewrites the shared <CODEX_HOME>/config.toml (notify) and reads its overlay config from the relocated directory. The swap is held, with the calling thread blocked and no JS running, until the child exists, then the app's own CODEX_HOME is restored` });

  // legacy (win32-only) TOML approvals migration: join(dirname(<CODEX_HOME>/config.toml), "computer-use", "config.toml")
  const legRe = new RegExp(`async function (${ID})\\((${ID})\\)\\{let (${ID})=(${ID})\\.default\\.join\\(\\4\\.default\\.dirname\\(\\2\\),\`computer-use\`,\`config\\.toml\`\\)`, 'g');
  const legs = [...main.text.matchAll(legRe)];
  const legExpr = [...main.text.matchAll(new RegExp(`(${PATH_FN('join')})\\((${PATH_FN('dirname')})\\((${ID})\\),${lit('computer-use')},(${lit('config.toml')})\\)`, 'g'))];
  const legWhy = `Computer Use relocation: the legacy (win32-only) approvals TOML migration reads and rewrites config.toml in $${COMPUTER_USE_DIR_ENV}, never in <CODEX_HOME>/computer-use`;
  if (legs.length === 1) {
    const [lm, lfn, larg, lvar, lpath] = legs[0];
    drafts.push({ id: 'cua-relocate-approvals', seam: 'other', file: main.file, op: 'replace-once', find: lm,
      text: `async function ${lfn}(${larg}){let ${lvar}=${lpath}.default.join(process.env.${COMPUTER_USE_DIR_ENV}||${lpath}.default.join(${lpath}.default.dirname(${larg}),\`computer-use-codexmods\`),\`config.toml\`)`,
      why: legWhy });
  } else if (legExpr.length === 1) {
    const [lm, ljoin, ldir, larg, ltoml] = legExpr[0];
    drafts.push({ id: 'cua-relocate-approvals', seam: 'other', file: main.file, op: 'replace-once', find: lm,
      text: `${ljoin}(process.env.${COMPUTER_USE_DIR_ENV}||${ljoin}(${ldir}(${larg}),\`computer-use-codexmods\`),${ltoml})`,
      why: legWhy });
  } else return miss(`the legacy approvals migration (join(dirname(config.toml), "computer-use", "config.toml")) occurs ${legs.length + legExpr.length} times in the main bundle (expected exactly 1)`);

  // distinct service-path variable
  const envHits = countIn(SERVICE_PATH_ENV);
  const em = envHits.length === 1 ? new RegExp(`(${ID})=(${Q})${SERVICE_PATH_ENV}\\2`).exec(envHits[0].text.slice(Math.max(0, envHits[0].i - 40), envHits[0].i + SERVICE_PATH_ENV.length + 2)) : null;
  if (!em) return miss(`"${SERVICE_PATH_ENV}" occurs ${envHits.length} times in .vite/build, expected exactly 1 as a constant`);
  drafts.push({ id: 'cua-service-path-env', seam: 'other', file: envHits[0].file, op: 'replace-once', find: em[0], text: em[0].replace(SERVICE_PATH_ENV, SERVICE_PATH_ENV_COPY),
    why: `Computer Use relocation: the app exports/reads the helper path in ${SERVICE_PATH_ENV_COPY} (matching the patched node client), so an ambient ${SERVICE_PATH_ENV} that points at the stock helper is ignored` });

  drafts.push({ id: 'cua-container', seam: 'other', file: main.file, op: 'replace-once', find: gm[0], text: gm[0].replace(GROUP, rename(GROUP)),
    why: 'Computer Use container isolation: the main bundle names the stock Group Container for approvals/IPC; the copy uses the renamed one used by its patched helper' });

  // remaining bare bundle ids (not part of the container id)
  const bare = countIn(BARE).filter((h) => !h.text.slice(Math.max(0, h.i - GROUP.length + BARE.length), h.i + BARE.length).endsWith(GROUP));
  if (!bare.some((h) => h.file === main.file)) return miss('no bare helper bundle id in the main bundle (ignore list, preferences domain, Apple-event target expected)');
  const perFile = new Map();
  for (const h of bare) perFile.set(h.file, [...(perFile.get(h.file) ?? []), h]);
  const perRole = new Map();                                              // ids are numbered per role (`main`, `src`, `worker`), in file-name then position order
  for (const [file, hits] of [...perFile].sort(([x], [y]) => x.localeCompare(y))) {
    const text = hits[0].text; const role = roleOf(file, main.file); let prevEnd = 0;
    for (const h of hits.sort((x, y) => x.i - y.i)) {
      const site = bareIdSite(text, h.i, prevEnd);
      if (typeof site === 'string') return miss(`the bare helper bundle id at ${file}:${h.i} cannot be anchored: ${site}`);
      const n = (perRole.get(role) ?? 0) + 1; perRole.set(role, n);
      drafts.push({ id: `cua-bundle-id:${role}:${n}`, seam: 'other', file, op: 'replace-once', find: site.find, text: site.find.replace(BARE, rename(BARE)),
        why: 'Computer Use isolation: the helper bundle identifier / preferences domain is renamed in the app too, so ignore lists, defaults and Apple events target only the copy\'s own helper' });
      prevEnd = site.to;
    }
  }
  // every find must apply exactly once, in order (they are non-overlapping)
  const texts = new Map(chunks.map((c) => [c.file, c.text]));
  try { for (const d of drafts) texts.set(d.file, applyOp(texts.get(d.file), d)); } catch (e) { return miss(`dry run failed: ${e.message}`); }
  for (const [f, t] of texts) if (t.includes(GROUP) || t.includes(`${BARE}\``) || t.includes(`"${BARE}`)) return miss(`${f} still names the stock helper after the dry run`);
  // static guarantee: after every transform no computer-use path of the bundles derives from codexHome, except the plugin's own skill file
  for (const [f, t] of texts) { const left = remainingComputerUsePaths(t); if (left.length) return miss(`${f} still joins a "computer-use" path off a non-relocated base after the dry run: ${left.map((l) => l.call).join(' | ')}`); }
  for (const [f, t] of texts) { const left = helperStartSites(t); if (left.length) return miss(`${f} starts the Computer Use helper without the private CODEX_HOME after the dry run: ${left.join(' | ')}`); }
  for (const [f, t] of texts) { const left = installerReachable(t); if (left.length) return miss(`${f} can still execute the locked-use installer after the dry run: ${left.join(' | ')}`); }
  return { drafts, missing: [] };
}

const QUOTES = '`"\'';
/** The string literal that ends just before `at` (its closing quote is the last char before a gap of at most `reach` non-quote chars), as [from, to) or null. */
function literalBefore(text, at, reach = 24) {
  for (let q = at - 1; q >= Math.max(0, at - 1 - reach); q--) {
    if (!QUOTES.includes(text[q])) continue;
    const open = text.lastIndexOf(text[q], q - 1);
    return open >= 0 && q - open <= 200 && !text.slice(open + 1, q).includes('\n') ? [open, q + 1] : null;
  }
  return null;
}
/** The string literal that starts within `reach` non-quote chars after `at`, as [from, to) or null. */
function literalAfter(text, at, reach = 24) {
  for (let q = at; q < Math.min(text.length, at + reach + 1); q++) {
    if (!QUOTES.includes(text[q])) continue;
    const close = text.indexOf(text[q], q + 1);
    return close >= 0 && close - q <= 200 && !text.slice(q + 1, close).includes('\n') ? [q, close + 1] : null;
  }
  return null;
}

/**
 * The exact text to replace for the bare bundle id literal at `i`: the literal itself plus its NEIGHBOURING string literal (the next one, else the
 * previous one, else both), whichever is the smallest that occurs exactly once in `text`, does not overlap an earlier edit (`from` >= `notBefore`) and
 * contains the id once. The find never starts or ends inside a minified identifier. Returns `{ find, from, to }`, or a string saying why not (fail closed).
 */
export function bareIdSite(text, i, notBefore = 0) {
  const start = i - 1; const end = i + BARE.length + 1;
  if (!QUOTES.includes(text[start]) || text[end - 1] !== text[start]) return 'it is not a complete string literal';
  const next = literalAfter(text, end); const prev = literalBefore(text, start);
  // the call argument just before (`…tmpdir(),"id"`: 22943 inlined the id into its only use), from the start of its identifier
  const call = /(?<![\w$])([A-Za-z_$][\w$]*\(\)),$/.exec(text.slice(Math.max(0, start - 40), start));
  const options = [[start, next?.[1]], [prev?.[0], end], [prev?.[0], next?.[1]], [call ? start - call[0].length : undefined, end]].filter(([a, b]) => a !== undefined && b !== undefined);
  for (const [from, to] of options) {
    if (from < notBefore) continue;
    const find = text.slice(from, to);
    if (find.split(BARE).length === 2 && text.split(find).length === 2) return { find, from, to };
  }
  return 'the literal and its neighbouring string literals do not make a find that occurs exactly once';
}

/** How many times the identifier occurs (declaration included). */
function countUses(text, name) {
  const re = new RegExp(`(?<![\\w$])(?<!(?<!\\.)\\.)${name.replaceAll('$', '\\$')}(?![\\w$])`, 'g');
  // A name inside a quoted token (`"application/vnd.3gpp.pic-bw-large"`, a key of an embedded media-type table) is text, not a use of
  // a function or constant. Only a quoted run of token characters counts as text: minified arithmetic (`e-bw-t`) is still a use.
  return [...text.matchAll(re)].filter((m) => !insideQuotedToken(text, m.index, name.length)).length;
}
/** Whether text[at, at+len) lies in a run of [A-Za-z0-9._+/-] that the same quote character opens and closes (bounded scan). */
function insideQuotedToken(text, at, len) {
  const TOKEN = /[A-Za-z0-9._+/-]/;
  let i = at - 1;
  while (i >= 0 && at - i < 200 && TOKEN.test(text[i])) i--;
  let j = at + len;
  while (j < text.length && j - at < 200 && TOKEN.test(text[j])) j++;
  const open = text[i], close = text[j];
  return (open === '"' || open === "'" || open === '`') && open === close && (i < at - 1 || j > at + len);
}

/** Text of the innermost unclosed `(` or `[` before `at` and the text in front of it, or null (bounded look-behind). */
function enclosing(text, at) {
  let depth = 0;
  for (let i = at - 1; i >= Math.max(0, at - 400); i--) {
    const c = text[i];
    if (c === ')' || c === ']') depth++;
    else if (c === '(' || c === '[') { if (depth === 0) return { open: c, i, before: text.slice(Math.max(0, i - 40), i) }; depth--; }
  }
  return null;
}
const JOINISH = /(?:\bjoin|\bresolve)\)?$/;

/**
 * Every path join in `text` that has the string "computer-use" as a segment: the literal itself as an argument of join/resolve, a constant `X=\`computer-use\``
 * or an array `X=[\`computer-use\`,…]` whose uses (`X`, `...X`) are arguments of join/resolve. `X.slice(1)` of an array that starts with the segment drops it and is not a finding.
 * Returns `{ call, base }` per finding where `base` is the first join argument.
 */
function computerUsePathsByText(text) {
  const out = [];
  const add = (open, usedAt) => out.push({ call: text.slice(Math.max(0, open.i - 18), Math.min(text.length, usedAt + 60)), base: text.slice(open.i + 1, usedAt).split(',')[0].trim() });
  const lit = /([`"'])computer-use\1/g;
  for (const m of text.matchAll(lit)) {
    const e = enclosing(text, m.index);
    if (e && e.open === '(' && JOINISH.test(e.before)) { add(e, m.index); continue; }
    const decl = /(?:^|[,;\s{(])([A-Za-z_$][\w$]*)=$/.exec(text.slice(Math.max(0, m.index - 40), m.index));
    const arr = e && e.open === '[' ? /(?:^|[,;\s{(])([A-Za-z_$][\w$]*)=$/.exec(e.before) : null;
    const name = decl?.[1] ?? arr?.[1];
    if (!name) continue;
    const first = decl ? true : text.slice(e.i + 1, m.index).trim() === '';
    const use = new RegExp(`(?<![\\w$])(?<!(?<!\\.)\\.)${name.replaceAll('$', '\\$')}(?![\\w$])`, 'g');
    for (const u of text.matchAll(use)) {
      if (u.index >= (arr ? e.i : m.index) - name.length - 1 && u.index <= m.index) continue;   // the declaration
      if (arr && first && text.startsWith('.slice(1)', u.index + name.length)) continue;
      const ue = enclosing(text, u.index);
      if (ue && ue.open === '(' && JOINISH.test(ue.before)) add(ue, u.index);
    }
  }
  return out;
}

/**
 * Every path join (or resolve) in `text` that has the string "computer-use" as a segment, found by meaning (adapters/tools/js-shape.mjs): an
 * argument that is the literal, or a name bound to it where it is used, or the spread of an array bound to it that starts with the literal
 * (`...X.slice(1)` drops it and is not a finding). A text that does not parse falls back to the text search (which can only find more).
 * Returns `{ call, base }` per finding where `base` is the first argument.
 */
export function computerUsePaths(text) {
  if (!text.includes('computer-use')) return [];
  const s = shapeOf(text);
  if (!s) return computerUsePathsByText(text);
  const out = [];
  /** Whether an expression can evaluate to the segment: the literal (or a name holding it), or a branch of `?:`, `&&`, `||`, `??` or a
   *  comma sequence that can. */
  const yields = (v, depth = 0) => {
    if (!v || depth > 8) return false;
    if (s.str(v) === 'computer-use') return true;
    if (v.type === 'ConditionalExpression') return yields(v.consequent, depth + 1) || yields(v.alternate, depth + 1);
    if (v.type === 'LogicalExpression') return yields(v.left, depth + 1) || yields(v.right, depth + 1);
    if (v.type === 'SequenceExpression') return yields(v.expressions.at(-1), depth + 1);
    return false;
  };
  /** Where the segment sits in the array a node is (or is bound to): its index, or -1. */
  const segmentAt = (node) => {
    let n = node;
    if (n?.type === 'Identifier') n = s.valueOf(n);
    return n?.type === 'ArrayExpression' ? n.elements.findIndex((e) => e && yields(e)) : -1;
  };
  /** Whether a spread puts the segment in the path: `...X` with it anywhere, `...X.slice(k)` with it at k or later. */
  const spreads = (arg) => {
    if (arg.type === 'CallExpression' && s.calleeMember(arg) === 'slice' && arg.callee.type === 'MemberExpression') {
      const k = arg.arguments[0]?.type === 'Literal' && Number.isInteger(arg.arguments[0].value) ? arg.arguments[0].value : 0;
      return segmentAt(arg.callee.object) >= k;
    }
    return segmentAt(arg) >= 0;
  };
  for (const c of [...s.calls('join'), ...s.calls('resolve')]) {
    const hit = c.arguments.some((a) => (a.type === 'SpreadElement' ? spreads(a.argument) : yields(a)));
    if (hit) out.push({ call: s.src(c).slice(0, 200), base: c.arguments[0] ? s.src(c.arguments[0]) : '' });
  }
  // fail closed: the segment put where the search above cannot follow it is a finding of its own, whatever path it may end up in: a
  // property, a name that holds more than one value (its declaration's value too: a reassigned name is not followed), or a value that
  // only may be the segment (`f?"computer-use":"x"`) held by a name
  const holds = (v) => v && (yields(v) || (v.type === 'ArrayExpression' && v.elements.some((e) => e && yields(e))));
  const plain = (v) => s.str(v) === 'computer-use' || (v.type === 'ArrayExpression' && v.elements.every((e) => !e || !yields(e) || s.str(e) === 'computer-use'));
  const writes = [];
  for (const n of s.nodes) {
    if (n.type === 'AssignmentExpression') writes.push([n, n.left, n.right]);
    else if (n.type === 'VariableDeclarator' && n.init) writes.push([n, n.id, n.init]);
  }
  for (const [n, left, right] of writes) {
    if (!holds(right)) continue;
    if (left.type === 'Identifier' && s.valueOf(left) === right && plain(right)) continue;
    out.push({ call: s.src(n).slice(0, 200), base: `(the segment assigned to ${s.src(left).slice(0, 60)})` });
  }
  return out;
}

/** `computerUsePaths` minus the bundled plugin's own skill file (`join(<pluginRoot>, "skills", "computer-use", "SKILL.md")`: plugin content, not the helper) and the already relocated bases. */
export function remainingComputerUsePaths(text) {
  return computerUsePaths(text).filter((p) => !/\.pluginRoot$/.test(p.base));
}

export const INSTALLER_NAME = 'Codex Computer Use Installer';

/** Index just after the brace-balanced `{…}` that opens at `open`. */
function bodyEnd(text, open) {
  let depth = 0;
  for (let i = open; i < Math.min(text.length, open + 3000); i++) { if (text[i] === '{') depth++; else if (text[i] === '}' && --depth === 0) return i + 1; }
  return -1;
}

/**
 * Every place the locked-use installer executable can still be reached from. The executable's name occurs as the last element of an array `P=[…,`Codex Computer Use Installer`]` (anything else naming it is a finding);
 * each use of `P` must sit in a named function `V` that nothing calls (a dead resolver) or whose body starts with a complete `return null;` or
 * `throw Error(<literal>);` statement, the use after it (dead code);
 * a call of any other `V`, or a use of `P` outside a function, is a finding. Returns descriptions (empty = unreachable).
 */
export function installerReachable(text) {
  const out = new Set();
  for (let at = text.indexOf(INSTALLER_NAME); at >= 0; at = text.indexOf(INSTALLER_NAME, at + 1)) {
    const e = enclosing(text, at);
    const arr = e && e.open === '[' ? /(?:^|[,;\s{(])([A-Za-z_$][\w$]*)=$/.exec(e.before) : null;
    if (!arr) { out.add(`${INSTALLER_NAME} outside a path array: ${text.slice(Math.max(0, at - 40), at + 50)}`); continue; }
    const P = arr[1];
    const use = new RegExp(`(?<![\\w$])(?<!(?<!\\.)\\.)${P.replaceAll('$', '\\$')}(?![\\w$])`, 'g');
    for (const u of text.matchAll(use)) {
      if (u.index >= e.i - P.length - 1 && u.index <= at) continue;                       // the declaration
      const from = Math.max(0, u.index - 300);
      const fns = [...text.slice(from, u.index).matchAll(/function ([A-Za-z_$][\w$]*)\([^()]*\)\{/g)].filter((m) => bodyEnd(text, from + m.index + m[0].length - 1) > u.index);
      const fn = fns.at(-1)?.[1];
      if (!fn) { out.add(`${P} used outside a named function: ${text.slice(Math.max(0, u.index - 40), u.index + 40)}`); continue; }
      const fnBody = from + fns.at(-1).index + fns.at(-1)[0].length;
      // the function returns null, or throws a literal message, as a COMPLETE first statement: the use comes after it and is dead code (a use inside the
      // throw's own operand would run before the throw, and is not exempt)
      if (/^(?:return null;|throw Error\((?:`[^`$\\]*`|"[^"\\]*"|'[^'\\]*')\);)/.test(text.slice(fnBody, u.index))) continue;
      const calls = [...text.matchAll(new RegExp(`(?<![\\w$.])${fn.replaceAll('$', '\\$')}(?![\\w$])`, 'g'))].filter((c) => !text.slice(Math.max(0, c.index - 9), c.index).endsWith('function '));
      for (const c of calls) out.add(`${fn} (resolves the installer path) is used: ${text.slice(Math.max(0, c.index - 40), c.index + 40)}`);
    }
  }
  return [...out];
}

/**
 * Every place a bundle can start the Computer Use helper, minus the ones that already run it with the private CODEX_HOME: a call of the native addon's
 * `spawnComputerUseService(` must sit in a function that reads `CODEX_MODS_COMPUTER_USE_DIR` and sets `process.env.CODEX_HOME`; any other use of the helper's
 * executable name (`SkyComputerUseService`) than the managed-service class's path join is reported too (a new spawn/open site would show up here).
 */
export function helperStartSites(text) {
  const out = [];
  for (let at = text.indexOf('spawnComputerUseService('); at >= 0; at = text.indexOf('spawnComputerUseService(', at + 1)) {
    const from = Math.max(0, at - 3000);
    const fns = [...text.slice(from, at).matchAll(/function ([A-Za-z_$][\w$]*)\([^]*?\)\{/g)].filter((m) => bodyEnd(text, from + m.index + m[0].length - 1) > at);
    const fn = fns.at(-1);
    const body = fn ? text.slice(from + fn.index, bodyEnd(text, from + fn.index + fn[0].length - 1)) : '';
    if (!(body.includes(`process.env.${COMPUTER_USE_DIR_ENV}`) && /process\.env\.CODEX_HOME=/.test(body) && body.includes('Atomics.wait('))) out.push(`spawnComputerUseService( outside the private-home wrapper: ${text.slice(Math.max(0, at - 60), at + 50)}`);
  }
  for (let at = text.indexOf('SkyComputerUseService'); at >= 0; at = text.indexOf('SkyComputerUseService', at + 1)) {
    if (!/\.join\([A-Za-z_$][\w$]*,([`"'])Contents\1,\1MacOS\1,\1SkyComputerUseService\1\)/.test(text.slice(Math.max(0, at - 60), at + 30)) && !text.slice(Math.max(0, at - 8), at + 22).includes('`/MacOS/SkyComputerUseService`')) out.push(`SkyComputerUseService named outside the managed-service path: ${text.slice(Math.max(0, at - 50), at + 40)}`);
  }
  return out;
}
