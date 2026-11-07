// Adapter pack tests. Pack-shape tests always run. Tests marked "stock" read the stock app of the pack's build (read-only, no launch): the
// installed one, or a copy kept under .tmp (stock.mjs); they are skipped when neither is that exact build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAsar } from './asar.mjs';
import { locateStock, locateStockApp, INSTALLED_APP } from './stock.mjs';
import { deriveUiSeams, declarationFor, sealGroupsAfter, isUiSeam, exposedKeys, ABI, UI_SEAM_KINDS, PROPS_KEYS } from './seams.mjs';
import { deriveTransforms, sourceFromAsar, COMPONENT_KEYS } from './derive.mjs';
import { applyBinaryPatches, applyBinaryPatch, sha256 as binSha256 } from './binary-patch.mjs';
import { deriveFrameworkPatches, mandatoryEditIds, checkConfigOverrides } from './generate-adapter.mjs';
import { persistedManagedConfig, deriveManagedConfigTransforms, CUA_REPL_STASH } from './managed-config.mjs';
import { deriveCuaSkillsTransform, exposedCuaSkills, SKILLS_ID, MISMATCH } from './cua-skills.mjs';
import { deriveCuaPeerAuthTransform, PEER_AUTH_ID } from './cua-peer-auth.mjs';
import { deriveCuaContainerPatches, deriveCuaContainerTransform, computerUsePaths, remainingComputerUsePaths, installerReachable, helperStartSites, INSTALLER_NAME, GROUP, TMP_DIR, BARE, rename, findSites, findNativePipeSites, NATIVE_PIPE_EDITS } from './cua-container.mjs';
import { applyAll, sha256, applyOp, sealTransforms, normalizeEditId, isMandatoryTransformId } from './transform.mjs';
import { protocolFromDir } from './protocol-from-schema.mjs';

/**
 * A copy origin edit (F3): a `replace-once` that only inserts `,void 0,void 0,{chat:<name>}` or `,void 0,void 0,{content:!1}` (the copy
 * helper's two own arguments as the app gives them, none, then where its content is from) before a call's `)`: nothing runs.
 */
export function originOnly(t) {
  if (!t || t.op !== 'replace-once' || typeof t.find !== 'string' || typeof t.text !== 'string' || t.text.length <= t.find.length) return false;
  let p = 0; while (p < t.find.length && t.find[p] === t.text[p]) p++;
  const ins = t.text.slice(p, p + t.text.length - t.find.length);
  return t.find[p] === ')' && t.text.slice(p + ins.length) === t.find.slice(p) && /^,void 0,void 0,\{(?:chat:[A-Za-z_$][\w$]*|content:!1)\}$/.test(ins);
}

/**
 * An identity props edit (H7v): a `replace-once` that only inserts `name:value` props at a props object's boundary (right after its `{`, or
 * right before its `}`), each value a name, a property path or `!0`, none a key the object already has nor twice (a name the seam spells
 * `$` for `$` is compared as written).
 */
export function propsOnly(t, allowed = PROPS_KEYS) {
  if (!t || t.op !== 'replace-once' || typeof t.find !== 'string' || typeof t.text !== 'string') return false;
  const norm = (x) => x.replace(/\\u0024/g, '$');
  const find = norm(t.find), text = norm(t.text);
  let p = 0; while (p < find.length && find[p] === text[p]) p++;
  let q = 0; while (q < find.length - p && find[find.length - 1 - q] === text[text.length - 1 - q]) q++;
  if (p + q !== find.length || text.length <= find.length) return false;
  const ins = text.slice(p, text.length - q);
  const after = find[p - 1] === '{' && ins.endsWith(',') && !ins.startsWith(',');
  const before = find[p] === '}' && ins.startsWith(',') && !ins.endsWith(',');
  if (!after && !before) return false;
  // the boundary is code: not inside a string or a template of the found text, and an object's (after `(`, `,`, `:`, `=` or `return`)
  let quote = null;
  for (let i = 0; i < (after ? p - 1 : p); i++) {
    const c = find[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; } else if (c === '"' || c === "'" || c === '`') quote = c;
  }
  if (quote) return false;
  if (after && !/(?:[(,:=]|return)\s*$/.test(find.slice(0, p - 1))) return false;
  const ID = '[A-Za-z_$][\\w$]*';
  const pairs = ins.replace(/^,|,$/g, '').split(',');
  const keys = [];
  for (const pair of pairs) {
    const m = new RegExp(`^(${ID}):(?:!0|${ID}(?:\\.${ID})*)$`).exec(pair);
    if (!m) return false;
    if (!allowed.includes(m[1])) return false;   // only the seam's identity keys (never React's `key`, nor one the props have)
    keys.push(m[1]);
  }
  if (new Set(keys).size !== keys.length) return false;
  return keys.every((k) => !new RegExp(`[{,]\\s*(?:${k}|"${k}"|'${k}')\\s*[:,}]`).test(find));
}
import { sha256File } from './generate-adapter.mjs';


/**
 * Defines the pack tests for one adapter directory. Stock-app tests skip unless exactly that build is installed.
 *
 * Nothing here is a constant of one build: offsets, function texts and counts come from the pack itself or from re-deriving it from the stock app.
 * The parts only a generated pack has (component exposures, host seams, Select recorded as missing, the statusbar note) are checked when the pack
 * declares them; a refreshed pack drops what its transforms no longer deliver. Every safety assertion applies to every pack.
 * `roleIds`: the pack's edit ids are hash-free (by role). `expectMissing`: what a full derivation reports missing for a generated pack.
 * `cuaSkills`: the pack must carry `cua-skills-no-expose` (decision N1; packs from before it do not).
 */
export function definePackTests({ dir, version, bundle, electron, keychain = false, roleIds = false, cuaSkills = false, expectMissing = ['component:Select'] }) {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, '..', '..');
  const PACK_DIR = join(here, '..', dir);
  const pack = JSON.parse(readFileSync(join(PACK_DIR, 'adapter.json'), 'utf8'));
  const APP = locateStockApp({ bundleVersion: pack.build.bundleVersion }) ?? INSTALLED_APP;   // the installed app, else a kept copy of this build
  const ASAR = join(APP, 'Contents', 'Resources', 'app.asar');
  const generated = Object.keys(pack.components).length > 0;                       // the pack declares component exposures (a generated pack)
  const mandatory = pack.transforms.filter((t) => isMandatoryTransformId(t.id));
  /** N9 (`cua-disable-cu-peer-auth`): the one mandatory edit that inserts after its site instead of replacing it. */
  const PEER_AUTH = PEER_AUTH_ID;
  // Transforms as compared with a re-derivation: ids by role (older packs embed chunk names), and the bundle-id edits by what they do (file, op, hashes: the
  // bytes they produce), since an older pack anchors them with a longer find around the same literal.
  const byRole = (ts) => ts.map((t) => {
    const id = normalizeEditId(t.id);
    return id.startsWith('cua-bundle-id:') ? { id, seam: t.seam, file: t.file, op: t.op, sha256Before: t.sha256Before, sha256After: t.sha256After } : { ...t, id };
  });
  /** The mandatory asar edits of the stock app, derived by the pack tools (hash-free ids, no seals). */
  const rederiveMandatory = (source) => {
    const cua = deriveCuaContainerTransform(source); const managed = deriveManagedConfigTransforms(source); const skills = deriveCuaSkillsTransform(source);
    // N9 (`cua-disable-cu-peer-auth`) is derived last, and only a pack that carries it is compared with it (the 20052 and 20156 packs predate it)
    const peer = mandatory.some((t) => t.id === PEER_AUTH_ID) ? deriveCuaPeerAuthTransform(source) : { drafts: [], missing: [] };
    return { drafts: [...cua.drafts, ...managed.drafts, ...skills.drafts, ...peer.drafts], missing: [...cua.missing, ...managed.missing, ...skills.missing, ...peer.missing] };
  };
  const edit = (t) => ({ id: normalizeEditId(t.id), file: t.file, op: t.op, find: t.find, text: t.text });
  /** Re-derived transforms as a pack of this age lists them: the 20052 and 20156 packs predate N9 and do not carry its peer-authorization edit. */
  const onlyListed = (ts) => ts.filter((t) => t.id !== PEER_AUTH_ID || mandatory.some((m) => m.id === PEER_AUTH_ID));
  const notesOf = () => readFileSync(join(PACK_DIR, 'NOTES.md'), 'utf8');
  /** The v1.21 host seams of the pack (`seams` minus the reserved `hooks` declaration of the UI seams). */
  const hostSeams = () => Object.entries(pack.seams ?? {}).filter(([k]) => k !== 'hooks');
  const uiTransforms = pack.transforms.filter(isUiSeam);

  const ANCHORS = ['settings.section', 'sidebar', 'workspace'];
  const COMPONENTS = ['Button', 'Switch', 'TextField', 'Select', 'Menu', 'Dialog', 'SettingsSection', 'SettingsRow', 'Tooltip', 'Icon'];

  // `stock()`: the app's code of exactly this build to read: CODEXMODS_STOCK_ASAR, the extraction `.tmp/asar-<bundle>/`, or the installed app (stock.mjs). Read-only.
  // `app()`: the whole app of this build (installed or kept), for the tests that read its binaries (framework, helper, app.asar bytes and header hash).
  let stockCache;
  function stock() {
    if (stockCache !== undefined) return stockCache;
    const s = locateStock({ bundleVersion: pack.build.bundleVersion, version: pack.build.version });
    stockCache = s ? { source: s.source, kind: s.kind, path: s.path } : null;
    return stockCache;
  }
  let appCache;
  function app() {
    if (appCache !== undefined) return appCache;
    appCache = null;
    if (!existsSync(ASAR)) return null;
    const v = spawnSync('plutil', ['-extract', 'CFBundleVersion', 'raw', '-o', '-', join(APP, 'Contents', 'Info.plist')], { encoding: 'utf8' });
    if (v.status !== 0 || v.stdout.trim() !== pack.build.bundleVersion) return null;   // a different build is installed: the app checks below only apply to this pack's build
    const asar = openAsar(ASAR);
    if (asar.size !== undefined && asar.headerSha256 !== readHeaderHashFromPlist()) { asar.close(); return null; }
    appCache = { asar, source: sourceFromAsar(asar) };
    return appCache;
  }
  function readHeaderHashFromPlist() {
    const r = spawnSync('plutil', ['-extract', 'ElectronAsarIntegrity.Resources/app\\.asar.hash', 'raw', '-o', '-', join(APP, 'Contents', 'Info.plist')], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
  }
  const noStock = () => (stock() ? false : `stock ChatGPT ${version} (${bundle}) not available (CODEXMODS_STOCK_ASAR, .tmp/asar-${bundle}/ or the installed app)`);
  const noApp = () => (app() ? false : `stock ChatGPT ${version} (${bundle}) not installed or kept (.tmp/stock-${bundle}/ChatGPT.app)`);

  test('adapter.json has every AdapterPack part, with build identity', () => {
    for (const k of ['adapterVersion', 'build', 'backend', 'asarPackageJson', 'protocol', 'transforms', 'anchors', 'components', 'react', 'theme']) assert.ok(k in pack, k);
    assert.match(pack.adapterVersion, /^\d+\.\d+\.\d+(?:\+refresh\.\d+)?$/);
    assert.deepEqual({ v: pack.build.version, b: pack.build.bundleVersion }, { v: version, b: bundle });
    assert.match(pack.build.asarSha256, /^[0-9a-f]{64}$/);
    assert.equal(pack.build.electronVersion, electron);
    const { configOverrides, ...backend } = pack.backend;           // v1.20: only packs whose managed config is not persisted declare overrides (checked below)
    assert.deepEqual(backend, { codexPath: 'Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex', nodePath: 'Resources/cua_node/bin/node', method: 'override', configKey: 'CODEX_CLI_PATH' });
    assert.ok(configOverrides === undefined || typeof configOverrides === 'object');
    assert.deepEqual(pack.owl, { iniPath: 'Resources/owl-app.ini', userDataDirectoryName: 'ChatGPT Mods' });
    assert.equal(pack.asarPackageJson, 'package.json');
  });

  test('protocol section equals the generator output for the upstream schema', () => {
    assert.deepEqual(pack.protocol, protocolFromDir(join(root, 'contracts', 'upstream', dir, 'schema')));
  });

  test('anchors: only AnchorNames, selectors non-empty, placement valid', () => {
    for (const [name, loc] of Object.entries(pack.anchors)) {
      assert.ok(ANCHORS.includes(name), name);
      assert.ok(Array.isArray(loc.selectors) && loc.selectors.length > 0, name);
      assert.ok(['inside', 'before', 'after'].includes(loc.placement), name);
      for (const s of loc.selectors) assert.equal(typeof s, 'string');
    }
    for (const name of ANCHORS) assert.ok(name in pack.anchors, `anchor ${name}`);
  });

  test('components map only ComponentNames, identity keys; Select is recorded as missing (when the pack declares components)', () => {
    for (const [name, key] of Object.entries(pack.components)) { assert.ok(COMPONENTS.includes(name)); assert.equal(key, name); }
    assert.ok(!('Select' in pack.components));
    assert.ok(COMPONENT_KEYS.includes('MenuParts'));
    if (generated) {
      assert.deepEqual(pack.react, { react: 'react', reactDom: 'reactDom' });
      assert.match(notesOf(), /missing[^\n]*Select|Select[^\n]*missing/i);
    } else assert.equal(pack.react, null, 'a pack without component exposures declares no React either');
  });

  test('every declared component, React and host seam is delivered by a transform of the pack (nothing is declared that no transform exposes)', () => {
    const exposed = new Set(pack.transforms.filter((t) => t.seam === 'components').flatMap((t) => [...t.text.matchAll(/"([\w$]+)":\(\)=>/g)].map((m) => m[1])));
    for (const key of Object.values(pack.components)) assert.ok(exposed.has(key), `component ${key} is exposed`);
    if (pack.react) for (const k of Object.values(pack.react)) assert.ok(exposed.has(k), `${k} is exposed`);
    for (const [name, seam] of hostSeams()) {
      if (seam.transform !== undefined) assert.ok(pack.transforms.some((t) => t.id === seam.transform), `seam ${name}: transform ${seam.transform}`);
      for (const k of seam.exports) assert.ok(exposed.has(k), `seam ${name}: ${k} is exposed`);
    }
    if (!generated) assert.deepEqual([...exposed], [], 'no exposures without declared components');
  });

  test('theme maps the semantic tokens to CSS custom properties: v1\'s nine, and in a pack with page seams the five of C5 and the code font (presentations.md V9)', () => {
    const v1 = ['accent', 'background', 'border', 'danger', 'fontFamily', 'radius', 'surface', 'text', 'textSecondary'];
    const v9 = ['onAccent', 'scrim', 'spacing', 'success', 'warning', 'codeFontFamily'];
    assert.deepEqual(Object.keys(pack.theme).sort(), (pack.seams?.hooks ? [...v1, ...v9] : v1).sort());
    for (const v of Object.values(pack.theme)) assert.match(v, /^--[a-z0-9-]+$/);
  });

  test('no transform text contains a String.replace replacement pattern ($&, $`, $\', $$, $1…): a builder that applies it with .replace() must not corrupt it', () => {
    for (const t of pack.transforms) assert.ok(!/\$[&`'$0-9<]/.test(t.text), `${t.id}: replacement pattern in the text`);
  });

  test('transform records are well-formed and chain per file', () => {
    assert.ok(pack.transforms.length >= 5);
    const last = new Map();
    const ids = new Set();
    for (const t of pack.transforms) {
      assert.ok(!ids.has(t.id), `duplicate id ${t.id}`); ids.add(t.id);
      assert.ok(['components', 'anchor', 'trusted-sender', 'preload', 'host', ...UI_SEAM_KINDS, 'other'].includes(t.seam), t.seam);
      assert.ok(['replace-once', 'insert-before-once', 'insert-after-once'].includes(t.op));
      assert.match(t.sha256Before, /^[0-9a-f]{64}$/); assert.match(t.sha256After, /^[0-9a-f]{64}$/);
      assert.ok(t.find.length > 0 && t.text.length > 0);
      if (last.has(t.file)) assert.equal(t.sha256Before, last.get(t.file), `${t.id} must start from the previous output of ${t.file}`);
      last.set(t.file, t.sha256After);
    }
    const sender = pack.transforms.filter((t) => t.seam === 'trusted-sender').map((t) => t.id);
    assert.ok(sender.length === 0 || JSON.stringify(sender) === JSON.stringify(['trusted-view-context', 'trusted-view-sender', 'trusted-view-startup']), 'the trusted sender seam is whole or absent');
    const exposures = pack.transforms.filter((t) => t.seam === 'components');
    assert.equal(exposures.length, new Set(exposures.map((t) => t.file)).size, 'one insertion per chunk');
    assert.ok(!pack.transforms.some((t) => t.seam === 'anchor'), 'settings.section is located from the DOM; no anchor transform');
    assert.ok(pack.transforms.filter((t) => isMandatoryTransformId(t.id)).every((t) => t.seam === 'other' && (t.op === 'replace-once' || t.id === PEER_AUTH)), 'every mandatory edit replaces its site once (the peer-auth edit inserts after its function head)');
    if (roleIds) {
      assert.ok(pack.transforms.every((t) => t.id === normalizeEditId(t.id) && !/[A-Za-z0-9_-]{8,12}\.[cm]?js/.test(t.id)), 'edit ids are by role, never a content-hashed chunk name');
      assert.ok(pack.mandatoryEdits.every((id) => id === normalizeEditId(id)));
    }
  });

  test('host seam (G-tree): one transform wraps HeaderToolbar by member name; the pack declares its exports', () => {
    const hosts = pack.transforms.filter((t) => t.seam === 'host');
    if (!hostSeams().length) { assert.deepEqual(hosts, []); return; }
    assert.deepEqual(hosts.map((t) => t.id), ['seam-host:thread-header']);
    const h = hosts[0];
    assert.equal(h.op, 'replace-once');
    assert.match(h.find, /^HeaderToolbar:Object\.assign\(\(0,[\w$]+\.memo\)\([\w$]+\),\{Actions:[\w$]+\}\)$/, 'located by the un-minified member names');
    assert.match(h.text, /globalThis\.__codexmods\?\.hosts\?\.\[`thread\.header`\]/);
    assert.match(h.text, /\{Actions:[\w$]+\}\)$/, 'the Actions member is kept');
    assert.deepEqual(Object.fromEntries(hostSeams()), { 'thread.header': { transform: 'seam-host:thread-header', exports: ['AppShell', 'RouteScope', 'ThreadScope', 'useScope'] }, 'thread.panel': { exports: ['registerTabType', 'rightPanel', 'SideChatTab', 'conversationManager', 'RouteScope', 'ThreadScope', 'useScope'] } });
    const exposed = pack.transforms.filter((t) => t.seam === 'components').map((t) => t.text).join('\n');
    for (const k of hostSeams().flatMap(([, x]) => x.exports)) assert.ok(exposed.includes(`"${k}":()=>`), `${k} exposed`);
  });

  // ---- the UI seams (docs/design/presentations.md V1, V2): derived again for every build, declared in seams.hooks, applied after every other transform
  test('UI seams: the pack declares exactly the page seams its transforms deliver (seams.hooks), with the ABI of the hook names', () => {
    const decl = pack.seams?.hooks;
    if (!uiTransforms.length) { assert.equal(decl, undefined, 'no UI seam transforms, nothing declared'); return; }
    assert.deepEqual(decl, declarationFor(pack.transforms));
    assert.equal(decl.abi, ABI);
    for (const id of [decl.jsx, decl.lazy, decl.appHost, ...(decl.taps ?? []), ...Object.values(decl.exposures ?? {})].filter(Boolean)) assert.ok(pack.transforms.some((t) => t.id === id), `declared transform ${id}`);
    // every declared exposure key is defined by the block of its transform, and every block key is declared
    const blockKeys = pack.transforms.filter((t) => t.seam === 'expose').flatMap((t) => exposedKeys(t.text).map((k) => [k, t.id]));
    assert.deepEqual(Object.fromEntries(blockKeys), decl.exposures ?? {});
    assert.equal(new Set(blockKeys.map(([k]) => k)).size, blockKeys.length, 'a key is defined once');
  });

  test('UI seams: the taps are all three or none; the seams are single; one exposure block per chunk; every edit is inert (calls only globalThis.__codexmods)', () => {
    const ids = (kind) => uiTransforms.filter((t) => t.seam === kind).map((t) => t.id);
    assert.ok([0, 3].includes(ids('tap').length), 'the three command taps apply together or not at all');
    if (ids('tap').length) assert.deepEqual(ids('tap'), ['seam-tap:commands', 'seam-tap:handlers', 'seam-tap:messages']);
    for (const kind of ['jsx', 'lazy', 'app-host', 'copy', 'command', 'attach', 'review-action', 'pr-create', 'main-modules', 'sidebar-groups', 'tab-visible']) assert.ok(ids(kind).length <= 1, kind);
    const blocks = uiTransforms.filter((t) => t.seam === 'expose');
    assert.equal(blocks.length, new Set(blocks.map((t) => t.file)).size, 'one insertion per chunk');
    for (const t of blocks) { assert.equal(t.op, 'insert-before-once'); assert.match(t.find, /^\/\/# sourceMappingURL=\S+\.js\.map$/); assert.ok(t.text.endsWith('\n')); }
    for (const t of uiTransforms) {
      // an identity props edit (H7v) only inserts `name:value` props (a name or a path, or !0) into the app's call: nothing runs
      if (t.seam === 'props') { assert.ok(propsOnly(t), `${t.id}: inserts props only`); continue; }
      if (t.seam === 'copy-origin') { assert.ok(originOnly(t), `${t.id}: inserts a copy's origin only`); continue; }
      if (t.seam === 'menu-command') { assert.ok(propsOnly(t, ['codexmodsCommand']), `${t.id}: inserts a menu item's command id only`); continue; }
      // a tab's visibility (layouts §4.1) only passes the tab to the kind's own isVisible: nothing else changes
      if (t.seam === 'tab-visible') { assert.equal(t.text.replace(/isVisible\?\.\(([\w$]+),[\w$]+\)!==!1\}$/, 'isVisible?.($1)!==!1}'), t.find, `${t.id}: passes the tab only`); continue; }
      assert.match(t.text, /globalThis\.__codexmods/); assert.ok(!t.text.includes('__codexmodsApp') && !t.text.includes('__codexmodsJsx'), `${t.id}: the probe's globals are not the product's`); assert.ok(!/(?<![\w$.])(?:eval|Function)\(/.test(t.text), t.id);
    }
    const inMain = (t) => t.seam === 'app-host' || t.seam === 'menu-command' || t.seam === 'main-modules';
    assert.ok(uiTransforms.filter((t) => !inMain(t)).every((t) => t.file.startsWith('webview/')) && uiTransforms.filter(inMain).every((t) => t.file.startsWith('.vite/build/')));
    // never before another transform of the same file: the mandatory edits keep the hashes they were derived with
    pack.transforms.forEach((t, i) => { if (!isUiSeam(t)) assert.ok(!pack.transforms.slice(0, i).some((u) => isUiSeam(u) && u.file === t.file), `${t.id} comes before the UI seams of ${t.file}`); });
  });

  test('stock: re-deriving the UI seams from the stock app reproduces the pack\'s', { skip: noStock() || (!pack.seams?.hooks && 'the pack declares no UI seams') }, () => {
    const { source } = stock();
    const ui = deriveUiSeams(source);
    const sealed = sealGroupsAfter(pack.transforms.filter((t) => !isUiSeam(t)), ui.groups, (p) => source.read(p));
    assert.deepEqual(sealed.dropped, []);
    const pick = (ts) => ts.filter(isUiSeam).map(({ id, seam, file, op, find, text, sha256Before, sha256After }) => ({ id, seam, file, op, find, text, sha256Before, sha256After }));
    assert.deepEqual(pick(sealed.transforms), pick(pack.transforms), 'every group derives on the stock app, and the pack carries exactly the derived edits');
    assert.deepEqual(declarationFor(sealed.transforms), pack.seams.hooks);
  });

  test('stock: every chunk the UI seams patch still parses (renderer chunks as modules, the main bundle as a script) after all transforms', { skip: noStock() || (!uiTransforms.length && 'the pack has no UI seams') }, () => {
    const { source } = stock();
    const out = applyAll(pack.transforms, (p) => source.read(p));
    for (const f of new Set(uiTransforms.map((t) => t.file))) {
      const r = spawnSync(process.execPath, ['--check', ...(f.startsWith('webview/') ? ['--input-type=module'] : [])], { input: out.get(f), encoding: 'utf8', maxBuffer: 1 << 26 });
      assert.equal(r.status, 0, `${f}: ${r.stderr.split('\n').slice(0, 4).join(' | ')}`);
    }
  });

  test('stock: header hash and full-file hash match the pack', { skip: noApp() }, async () => {
    assert.equal(app().asar.headerSha256, readHeaderHashFromPlist());
    assert.equal(await sha256File(ASAR), pack.build.asarSha256);
  });

  test('stock: every transform applies to the stock files and sha256Before/After match', { skip: noStock() }, () => {
    const { source } = stock();
    const read = (p) => source.read(p);
    const out = applyAll(pack.transforms, read);
    assert.equal(out.size, new Set(pack.transforms.map((t) => t.file)).size, 'one result per transformed file');
    for (const t of pack.transforms) assert.equal(sha256(read(t.file)), pack.transforms.find((x) => x.file === t.file).sha256Before);
  });

  test('stock: the mandatory edits re-derived from the stock app are exactly the pack\'s (same sites, finds and texts, in order), by string anchors and structure', { skip: noStock() }, () => {
    const { source } = stock();
    const r = rederiveMandatory(source);
    assert.deepEqual(r.missing, []);
    const isBundleId = (t) => normalizeEditId(t.id).startsWith('cua-bundle-id:');
    assert.deepEqual(r.drafts.map((d) => [d.id, d.file, d.op]), mandatory.map((t) => [normalizeEditId(t.id), t.file, t.op]), 'the same edits, at the same sites, in the same order');
    // every edit but the bundle ids (which an older pack may anchor differently: a longer find around the same literal) has the same find and text
    assert.deepEqual(r.drafts.filter((d) => !isBundleId(d)).map(edit), mandatory.filter((t) => !isBundleId(t)).map(edit));
    // and the patched files are the same bytes either way
    const patched = (list) => { const m = new Map(); for (const t of list) m.set(t.file, applyOp(m.get(t.file) ?? source.read(t.file), t)); return new Map([...m].map(([f, x]) => [f, sha256(x)])); };
    assert.deepEqual(patched(r.drafts), patched(mandatory));
    // sealed on their own they chain from the stock files; the pack's own hashes agree whenever no other transform of the pack touches the same file
    const sealed = sealTransforms(r.drafts, (p) => source.read(p));
    for (const s of sealed) {
      const p = mandatory.find((t) => normalizeEditId(t.id) === s.id);
      const earlier = pack.transforms.slice(0, pack.transforms.indexOf(p)).some((t) => t.file === p.file && !isMandatoryTransformId(t.id));
      if (!earlier) assert.deepEqual([s.id, s.file, s.sha256Before, s.sha256After], [normalizeEditId(p.id), p.file, p.sha256Before, p.sha256After], s.id);
    }
  });

  test('stock: re-deriving every transform from the stock app reproduces the committed transforms and components exactly (generated packs)', { skip: noStock() || (!generated && 'a refreshed pack carries only the transforms it could carry over') }, () => {
    const r = deriveTransforms(stock().source);
    assert.deepEqual(byRole(onlyListed(r.transforms)), byRole(pack.transforms.filter((t) => !isUiSeam(t))));          // the UI seams come after these (checked below)
    assert.deepEqual(r.components, pack.components);
    assert.deepEqual(r.react, pack.react);
    assert.deepEqual(r.missing.map((m) => m.item), expectMissing);
  });

  test('stock: every file the pack patches still compiles as a script after all transforms', { skip: noStock() }, () => {
    const { source } = stock();
    const out = applyAll(pack.transforms, (p) => source.read(p));
    for (const [file, text] of out) if (file.startsWith('.vite/')) assert.doesNotThrow(() => new vm.Script(text, { filename: file }), file);
  });

  test('stock: every transform fails closed on a changed byte, a duplicated site or a changed site', { skip: noStock() }, () => {
    const { source } = stock();
    const current = new Map();
    for (const t of pack.transforms) {
      const text = current.get(t.file) ?? source.read(t.file);
      assert.throws(() => applyAll([t], () => text + ' '), /sha256Before mismatch/, `${t.id}: input changed by one byte`);
      assert.throws(() => applyOp(text.replace(t.find, () => t.find + t.find), t), /occurs 2 times/, `${t.id}: site duplicated`);
      assert.throws(() => applyOp(text.replace(t.find, () => t.find.slice(0, -1) + '\u0000'), t), /occurs 0 times/, `${t.id}: site changed`);
      current.set(t.file, applyOp(text, t));
    }
  });

  if (keychain) {
    const KEY = () => pack.binaryPatches.filter((p) => p.id.startsWith('keychain-service-name'));
    const CUA = () => pack.binaryPatches.filter((p) => p.id.startsWith('cua-container:'));
    const FRAMEWORK = () => join(APP, 'Contents', KEY()[0].file);
    test('binaryPatches: keychain-service-name changes both "Codex" words to "Codey" (service and account), chained, exact bytes', () => {
      const ps = KEY();
      assert.deepEqual(ps.map((p) => p.id), ['keychain-service-name', 'keychain-service-name-account']);
      assert.ok(ps.every((p) => p.file === ps[0].file && p.file.startsWith('Frameworks/') && !p.file.includes('/Current/')));
      assert.ok(ps.every((p) => p.before === '080f8052' && p.after === '280f8052'), 'movz w8,#0x78 → movz w8,#0x79 (little-endian words 0x52800f08 → 0x52800f28)');
      assert.ok(ps.every((p) => Number.isInteger(p.offset) && p.offset > 0 && p.offset % 4 === 0), 'whole instruction words');
      assert.equal(new Set(ps.map((p) => p.offset)).size, ps.length);
      assert.equal(ps[1].sha256Before, ps[0].sha256After);
      assert.ok(ps.every((p) => /^[0-9a-f]{64}$/.test(p.sha256Before) && /^[0-9a-f]{64}$/.test(p.sha256After) && /Storage Key/.test(p.justification)));
      assert.ok(!pack.transforms.some((t) => t.id === 'keychain-service'), 'the ineffective productName transform is gone');
      assert.match(readFileSync(join(PACK_DIR, 'NOTES.md'), 'utf8'), /keychain-service-name/);
    });

    const AURA = () => pack.binaryPatches.filter((p) => p.id.startsWith('aura-fallback'));
    test('binaryPatches: the Aura fallback ("Aura Safe Storage"/"Aura") becomes "Aura Safe Storagf"/"Aurb", chained after Codey, exact words', () => {
      const ps = AURA();
      assert.deepEqual(ps.map((p) => p.id), ['aura-fallback-service', 'aura-fallback-account']);
      assert.ok(ps.every((p) => Number.isInteger(p.offset) && p.offset > 0 && p.offset % 4 === 0), 'whole instruction words');
      assert.deepEqual(ps.map((p) => [p.before, p.after]), [['a90c8052', 'c90c8052'], ['482eac72', '484eac72']], 'movz w9,#0x65→#0x66 (e→f); movk w8,#0x6172→#0x6272,lsl 16 (a→b)');
      const all = pack.binaryPatches.filter((p) => p.file === ps[0].file);
      assert.deepEqual(all.map((p) => p.id), ['keychain-service-name', 'keychain-service-name-account', 'aura-fallback-service', 'aura-fallback-account']);
      all.forEach((p, i) => { if (i) assert.equal(p.sha256Before, all[i - 1].sha256After); });
    });

    test('stock: the locators re-derive exactly the committed keychain + Aura patches from the installed framework', { skip: noApp() }, () => {
      const r = deriveFrameworkPatches(APP);
      assert.deepEqual(r.missing, []);
      assert.deepEqual(r.patches, [...KEY(), ...AURA()]);
    });

    test('stock: the framework patches apply (only the four words change; nothing else), and a byte mismatch fails closed', { skip: noApp() }, () => {
      const buf = readFileSync(FRAMEWORK());
      const ps = [...KEY(), ...AURA()];
      assert.equal(binSha256(buf), ps[0].sha256Before);
      const out = applyBinaryPatches(buf, ps);
      assert.equal(binSha256(out), ps.at(-1).sha256After);
      const diff = []; for (let i = 0; i < buf.length; i++) if (buf[i] !== out[i]) diff.push(i);
      const differing = ps.flatMap((p) => { const b = Buffer.from(p.before, 'hex'); const a = Buffer.from(p.after, 'hex'); return [...b].flatMap((x, i) => (x !== a[i] ? [p.offset + i] : [])); });
      assert.equal(differing.length, ps.length, 'the pack changes one byte per patch');
      assert.deepEqual(diff, differing.sort((a, b) => a - b), 'exactly one byte per patch differs (Codey ×2, Aura ×2), at the offsets the pack names');
      for (const p of ps) assert.equal(out.readUInt32LE(p.offset), Buffer.from(p.after, 'hex').readUInt32LE(0), `${p.id}: the instruction word is the patched one`);
      // the data strings shared with the importer are untouched
      assert.ok(out.includes(Buffer.from('Aura Safe Storage\0')));
      // one flipped byte anywhere: the whole-file hash no longer matches
      const bad = Buffer.from(buf); bad[1234567] ^= 1;
      assert.throws(() => applyBinaryPatch(bad, ps[0]), /sha256Before mismatch/);
      let cur = buf;
      for (const p of ps) {                                  // each patch against the buffer its sha256Before describes
        assert.throws(() => applyBinaryPatch(cur, { ...p, offset: p.offset + 4 }), /not the expected/);
        assert.throws(() => applyBinaryPatch(cur, { ...p, after: p.after.slice(0, 6) }), /length mismatch/);
        cur = applyBinaryPatch(cur, p);
      }
      assert.throws(() => applyBinaryPatch(buf, ps[1]), /sha256Before mismatch/, 'out-of-order application breaks the chain');
      assert.throws(() => applyBinaryPatch(buf, ps[3]), /sha256Before mismatch/);
    });

    const NAMES = [GROUP, TMP_DIR, BARE].map((n) => Buffer.from(n).toString('hex'));
    const NATIVE = NATIVE_PIPE_EDITS.map((e) => Buffer.from(e.before).toString('hex'));
    test('Computer Use isolation: the pack renames the stock container, lock-screen dir and helper bundle id, and fixes the node client (shape)', () => {
      const ps = CUA();
      assert.ok(ps.length >= 20, `${ps.length} patches: helper service/client/guardian/plugin/installer tool, node_repl, plists and both native-pipe.js copies`);
      assert.equal(new Set(ps.map((p) => p.id)).size, ps.length);
      for (const p of ps) {
        assert.ok([...NAMES, ...NATIVE].includes(p.before), p.id);
        if (NAMES.includes(p.before)) assert.equal(Buffer.from(p.after, 'hex').toString(), rename(Buffer.from(p.before, 'hex').toString()));
        assert.equal(p.after.length, p.before.length, 'same length');
        assert.ok(p.file.startsWith('Resources/cua_node/'));
      }
      const byFile = new Map(); for (const p of ps) byFile.set(p.file, [...(byFile.get(p.file) ?? []), p]);
      for (const list of byFile.values()) list.forEach((p, i) => { if (i) assert.equal(p.sha256Before, list[i - 1].sha256After, `${p.id} chains on the previous patch of the same file`); });
      for (const suffix of ['MacOS/SkyComputerUseService', 'MacOS/SkyComputerUseClient', 'MacOS/CUALockScreenGuardian', 'bin/node_repl', 'mac/native-pipe.js', 'Codex Computer Use.app/Contents/Info.plist', 'CUALockScreenGuardian.app/Contents/Info.plist', 'SkyComputerUseClient.app/Contents/Info.plist']) assert.ok(ps.some((p) => p.file.endsWith(suffix)), suffix);
      assert.equal(ps.filter((p) => p.file.endsWith('mac/native-pipe.js') && NATIVE.includes(p.before)).length, 4, 'two edits in each of the two native-pipe.js copies');
      assert.match(readFileSync(join(PACK_DIR, 'NOTES.md'), 'utf8'), /Computer Use container/);
    });

    test('Computer Use isolation: asar transforms (relocation, distinct service-path variable, container id, bundle ids) are present, once each, same-site', () => {
      const ids = pack.transforms.map((t) => t.id);
      for (const id of ['cua-relocate-dir', 'cua-relocate-config', 'cua-relocate-installer', 'cua-relocate-approvals', 'cua-disable-locked-use', 'cua-helper-private-home', 'cua-service-path-env', 'cua-container']) assert.equal(ids.filter((x) => x === id).length, 1, id);
      assert.ok(ids.filter((x) => x.startsWith('cua-bundle-id:')).length >= 3);
      assert.ok(pack.transforms.filter((t) => t.id.startsWith('cua-')).every((t) => t.seam === 'other' && (t.op === 'replace-once' || t.id === PEER_AUTH)));
      const reloc = pack.transforms.find((t) => t.id === 'cua-relocate-dir');
      assert.match(reloc.text, /process\.env\.CODEX_MODS_COMPUTER_USE_DIR/);
      assert.doesNotMatch(reloc.text, /`computer-use`/, 'the stock directory name is not a fallback');
      assert.equal(pack.transforms.find((t) => t.id === 'cua-container').text, pack.transforms.find((t) => t.id === 'cua-container').find.replace(GROUP, rename(GROUP)));
      // config, installer and the legacy approvals path use the same directory variable and the same never-stock fallback as cua-relocate-dir
      for (const id of ['cua-relocate-config', 'cua-relocate-installer', 'cua-relocate-approvals']) {
        const t = pack.transforms.find((x) => x.id === id);
        assert.match(t.text, /process\.env\.CODEX_MODS_COMPUTER_USE_DIR/, id);
        assert.match(t.text, /computer-use-codexmods/, `${id}: same fallback as cua-relocate-dir`);
        assert.doesNotMatch(t.text, /`computer-use`/, `${id}: the stock directory name is not a fallback`);
        assert.ok(!t.find.includes('CODEX_MODS_COMPUTER_USE_DIR') && t.find !== t.text, `${id}: replaces the stock join`);
      }
      assert.equal(pack.transforms.find((t) => t.id === 'cua-relocate-config').file, reloc.file);
      const hp = pack.transforms.find((t) => t.id === 'cua-helper-private-home');
      assert.equal(hp.file, reloc.file);
      assert.match(hp.text, /process\.env\.CODEX_MODS_COMPUTER_USE_DIR/);
      assert.match(hp.text, /process\.env\.CODEX_HOME=require\(`path`\)\.dirname\(mods\)/, 'CODEX_HOME = the profile dir (dirname of the computer-use dir)');
      assert.match(hp.text, /Atomics\.wait\(gate,0,0,10\)/, 'the swap is held (calling thread blocked) until the asynchronous spawn has happened');
      assert.match(hp.text, /finally\{if\(home==null\)delete process\.env\.CODEX_HOME;else process\.env\.CODEX_HOME=home\}/, 'the app\'s own value is restored');
      const lk = pack.transforms.find((t) => t.id === 'cua-disable-locked-use');
      assert.equal(lk.file, reloc.file);
      assert.doesNotMatch(lk.text, /execFile|spawn|exec\(|OK: installed/, 'the replacement never calls anything that could run the installer');
      assert.match(lk.text, /^async function [\w$]+\(e\)\{return null\}async function [\w$]+\(\)\{return null\}async function [\w$]+\([\w$]+\)\{throw Error\(`Locked use is unavailable in this copy`\)(?:\}|;let\{stdout:[\w$]+\}=await [\w$]+\()$/,
        'install/uninstall and status return null; the executor throws before anything (on 22943 the rest of its body, its inlined installer path, is unreachable after the throw)');
      assert.match(lk.find, /OK: installed/, 'the stock status protocol is what is replaced');
    });

    test('mandatoryEdits lists exactly the keychain/Aura/Computer Use edits, all present in the pack', () => {
      assert.ok(Array.isArray(pack.mandatoryEdits) && pack.mandatoryEdits.length > 0);
      assert.deepEqual([...pack.mandatoryEdits].sort(), mandatoryEditIds(pack.transforms, pack.binaryPatches).sort(), 'exactly the isolation edits the pack contains (a refreshed pack keeps its predecessor\'s order)');
      assert.equal(new Set(pack.mandatoryEdits).size, pack.mandatoryEdits.length);
      const have = new Set([...pack.transforms.map((t) => t.id), ...pack.binaryPatches.map((p) => p.id)]);
      for (const id of pack.mandatoryEdits) assert.ok(have.has(id), id);
      for (const id of ['keychain-service-name', 'keychain-service-name-account', 'aura-fallback-service', 'aura-fallback-account', 'cua-relocate-dir', 'cua-relocate-config', 'cua-relocate-installer', 'cua-relocate-approvals', 'cua-disable-locked-use', 'cua-helper-private-home', 'cua-service-path-env', 'cua-container']) assert.ok(pack.mandatoryEdits.includes(id), id);
      assert.match(readFileSync(join(PACK_DIR, 'NOTES.md'), 'utf8'), /mandatory/i);
    });

    test('stock: the Computer Use locators re-derive exactly the committed patches (and, for a generated pack, all transforms)', { skip: noApp() }, () => {
      const r = deriveCuaContainerPatches(join(APP, 'Contents'));
      assert.deepEqual(r.missing, []);
      assert.deepEqual(r.patches, CUA());
      if (!generated) return;                                      // a refreshed pack's mandatory transforms are checked by the re-derivation test above
      const d = deriveTransforms(stock().source);
      assert.deepEqual(byRole(onlyListed(d.transforms)), byRole(pack.transforms.filter((t) => !isUiSeam(t))));
      assert.deepEqual(d.missing.map((m) => m.item), expectMissing);
    });

    test('stock: applying the patches removes every non-signature use of the stock helper identity, touches nothing else, and fails closed on a changed byte', { skip: noApp() }, () => {
      const byFile = new Map(); for (const p of CUA()) byFile.set(p.file, [...(byFile.get(p.file) ?? []), p]);
      for (const [file, list] of byFile) {
        const buf = readFileSync(join(APP, 'Contents', file));
        const out = applyBinaryPatches(buf, list);
        assert.equal(binSha256(out), list.at(-1).sha256After, file);
        assert.deepEqual(findSites(out), [], `${file}: no stock container/lock-screen/bundle name left outside the signature`);
        if (file.endsWith('native-pipe.js')) assert.ok(findNativePipeSites(out).every((x) => x.offsets.length === 0) && !out.toString().includes('computer-use","Codex'), `${file}: no stock-home or env fallback left`);
        let changed = 0; for (let i = 0; i < buf.length; i++) if (buf[i] !== out[i]) changed++;
        assert.ok(changed >= list.length && changed <= list.reduce((n, p) => n + p.after.length / 2, 0), `${file}: only patched bytes changed`);
        const bad = Buffer.from(buf); bad[list[0].offset] ^= 0x20;
        assert.throws(() => applyBinaryPatch(bad, list[0]), /sha256Before mismatch/);
        assert.throws(() => applyBinaryPatch(buf, { ...list[0], before: '00' + list[0].before.slice(2) }), /not the expected/);
      }
    });

    test('stock: the asar transforms leave no stock helper name or ambient variable in the main process code', { skip: noStock() }, () => {
      const { source } = stock();
      const out = applyAll(pack.transforms, (p) => source.read(p));
      for (const [file, text] of out) {
        if (!file.startsWith('.vite/')) continue;
        assert.ok(!text.includes(GROUP), `${file}: stock container id`);
        assert.ok(!/[`"']com\.openai\.sky\.CUAService[`"']/.test(text), `${file}: stock bundle id`);
        assert.ok(!/SKY_CUA_SERVICE_PATH[`"']/.test(text), `${file}: ambient SKY_CUA_SERVICE_PATH`);
      }
    });

    test('the managed config is not persisted (three mandatory transforms) and the baseline is declared as backend.configOverrides', () => {
      const ids = ['managed-config-no-persist', 'managed-config-no-persist-cua-repl', 'managed-config-cua-repl-thread'];
      for (const id of ids) {
        assert.equal(pack.transforms.filter((t) => t.id === id).length, 1, id);
        assert.ok(pack.mandatoryEdits.includes(id), `${id} is mandatory`);
      }
      const np = pack.transforms.find((t) => t.id === 'managed-config-no-persist');
      const kept = /^let ([\w$]+)=([\w$]+)\(([\w$]+)\)\.slice\(1\)$/.exec(np.text);
      const inline = /^let ([\w$]+)=[\w$]+\.map\(\(?[\w$]+\)?=>\(\{keyPath:`shell_environment_policy\.set\.\$\{[\w$]+\}`,mergeStrategy:[`"']replace[`"'],value:null\}\)\)$/.exec(np.text);
      assert.ok(kept || inline, 'only the shell_environment_policy deletions remain: the edit list without its first (node_repl) edit');
      if (kept) assert.ok(np.find.startsWith(`let ${kept[1]}=[...${kept[2]}(${kept[3]}),{keyPath:\`mcp_servers.\${`), 'the stock list also wrote the cua_repl key');
      else assert.ok(np.find.startsWith(`let ${inline[1]}=[...(`) && /\{keyPath:`mcp_servers\.\$\{[\w$]+\.[\w$]+\}`[^]*\{keyPath:`mcp_servers\.\$\{/.test(np.find), 'the stock list wrote the node_repl and the cua_repl keys');
      const rp = pack.transforms.find((t) => t.id === 'managed-config-no-persist-cua-repl');
      // (22943 writes a helper file into the same cache just before: the find starts there, and what follows that write is kept in front)
      assert.match(rp.text, new RegExp(`^(?:Object\\.assign\\([^;]*\\);)?return ${CUA_REPL_STASH.replace(/\./g, '\\.')}=[\\w$]+\\?structuredClone\\([\\w$]+\\):null,[\\w$]+\\}$`), 'the plugin definition is kept in memory');
      assert.ok(!/writeFile|rename/.test(rp.text), 'nothing is written');
      assert.match(rp.find, /writeFile\)\(e,[\w$]+\),await ?\(0,[\w$]+\.rename\)\(e,[\w$]+\)\}return [\w$]+\}$/, 'the stock tail wrote the shared plugin .mcp.json');
      const th = pack.transforms.find((t) => t.id === 'managed-config-cua-repl-thread');
      assert.ok(th.text.includes(CUA_REPL_STASH) && !th.text.includes('writeFile'), 'the per-thread config carries the stashed definition');
      assert.match(th.text, /^(?:return!|[\w$]+!=null&&[\w$]+!=null\?|null!=[\w$]+&&null!=[\w$]+&&[^?]*CODEX_APP_SERVER_USE_LOCAL_DAEMON[^?]*\?)/,
        'the whole assembly (the app never set cua_repl per thread), the fallback after the app\'s own assignment, or (22943) after the app\'s own with its local daemon');
      assert.deepEqual(checkConfigOverrides(pack.backend.configOverrides), []);
      const o = pack.backend.configOverrides;
      assert.deepEqual(o.notify, ['${computerUseDir}/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient', 'turn-ended']);
      const nr = o['mcp_servers.node_repl'];
      assert.equal(nr.command, '${resources}/cua_node/bin/node_repl');
      assert.deepEqual(nr.args, []);
      assert.equal(nr.env.CODEX_CLI_PATH, '${relayPath}');
      assert.equal(nr.env.CODEX_HOME, '${codexHome}');
      assert.equal(nr.env.BROWSER_USE_CODEX_APP_VERSION, pack.build.version, 'the declared app version is the pack\'s build');
      assert.ok(!('mcp_servers.cua_repl' in o) && !('mcp_servers.codex_app' in o), 'cua_repl travels per thread (dynamic surfaces), codex_app is not copy-specific: see NOTES');
      assert.match(readFileSync(join(PACK_DIR, 'NOTES.md'), 'utf8'), /managed-config-no-persist/);
    });

    test('stock: after the transforms nothing of the managed config is persisted by the main-process code, and the declared env names exist in the stock bundles', { skip: noStock() }, () => {
      const { source } = stock();
      const out = applyAll(pack.transforms, (p) => source.read(p));
      const files = source.list('').filter((p) => /\.(m?js|cjs)$/.test(p) && !p.startsWith('webview/'));
      const mainFile = pack.transforms.find((t) => t.id === 'managed-config-no-persist').file;
      // the checker is anchored on the managed tool sync, which lives in the main bundle only: it is run there (a file without the anchors is a finding, by design)
      assert.equal(persistedManagedConfig(source.read(mainFile)).length, 3, 'the checker sees the three stock writes (node_repl edit list, cua_repl edit, plugin .mcp.json)');
      assert.deepEqual(persistedManagedConfig(out.get(mainFile)), []);
      // no other script writes the managed servers: they name neither the config keyPath of the sync nor the cua-repl plugin definition
      for (const f of files.filter((x) => x !== mainFile)) {
        const t = out.get(f) ?? source.read(f);
        assert.ok(!/keyPath:`mcp_servers\.\$\{/.test(t) && !t.includes('mcpServers.cua_repl'), `${f} writes managed tool configuration`);
      }
      // every other config/batchWrite edit that names an mcp server key is one of the per-thread / enablement strings: of the keyPaths on mcp_servers only the edit list builder's remains
      const KEYPATH = /keyPath:`mcp_servers\.\$\{[\w$]+\.[\w$]+\}`/g;
      const byFunction = /\.slice\(1\)$/.test(pack.transforms.find((t) => t.id === 'managed-config-no-persist').text);
      assert.equal((source.read(mainFile).match(KEYPATH) ?? []).length, 2, 'stock: the node_repl edit (in its builder, or inline) and the cua_repl edit');
      assert.equal((out.get(mainFile).match(KEYPATH) ?? []).length, byFunction ? 1 : 0, 'patched: only the builder (its result is sliced) remains, or nothing (22943: the list was built inline)');
      const text = files.map((f) => source.read(f)).join('\n');
      for (const name of Object.keys(pack.backend.configOverrides['mcp_servers.node_repl'].env)) assert.ok(text.includes(name), `${name} is an env name the app itself sets for node_repl`);
      assert.ok(text.includes('--previous-notify'), 'sanity: notify is only written by the helper on macOS (Windows path in the app)');
    });

    test('N1: the CUA skill exposure is a no-op (one mandatory transform that returns first)', { skip: !cuaSkills && !pack.transforms.some((t) => t.id === SKILLS_ID) && 'a pack from before decision N1' }, () => {
      assert.equal(pack.transforms.filter((t) => t.id === SKILLS_ID).length, 1);
      assert.ok(pack.mandatoryEdits.includes(SKILLS_ID), `${SKILLS_ID} is mandatory`);
      const t = pack.transforms.find((x) => x.id === SKILLS_ID);
      const head = /^async function [\w$]+\([\w$]+\)\{/.exec(t.find)?.[0];
      assert.ok(head && t.find.includes(MISMATCH), 'the find is the skill exposure function');
      assert.deepEqual([t.op, t.text], ['replace-once', `${head}return;${t.find.slice(head.length)}`], 'the function returns before its body');
      assert.match(notesOf(), new RegExp(SKILLS_ID));
    });

    test('stock: the CUA skill exposure writes the plugin cache in the stock main bundle and nothing after the transforms; no other script does', { skip: noStock() || (!cuaSkills && !pack.transforms.some((t) => t.id === SKILLS_ID) && 'a pack from before decision N1') }, () => {
      const { source } = stock();
      const out = applyAll(pack.transforms, (p) => source.read(p));
      const mainFile = pack.transforms.find((t) => t.id === SKILLS_ID).file;
      assert.equal(exposedCuaSkills(source.read(mainFile)).length, 1, 'the checker sees the stock exposure');
      assert.deepEqual(exposedCuaSkills(out.get(mainFile)), []);
      for (const f of source.list('').filter((p) => /\.(m?js|cjs)$/.test(p) && !p.startsWith('webview/') && p !== mainFile)) {
        const text = source.read(f);
        assert.ok(!text.includes(MISMATCH) && !/`\.codex-plugin`,`skill-\$\{/.test(text), `${f} exposes CUA skills`);
      }
    });

    test('stock: every start site of the Computer Use helper runs with the private CODEX_HOME, and the native addon spawns with the live environment', { skip: noApp() }, () => {
      const { source } = stock();
      const out = applyAll(pack.transforms, (p) => source.read(p));
      const files = source.list('').filter((p) => /\.(m?js|cjs)$/.test(p) && !p.startsWith('webview/'));
      const mainFile = pack.transforms.find((t) => t.id === 'cua-helper-private-home').file;
      assert.equal(helperStartSites(source.read(mainFile)).length, 1, 'the checker sees the one stock start site (pd -> sky.node spawnComputerUseService)');
      for (const f of files) assert.deepEqual(helperStartSites(out.get(f) ?? source.read(f)), [], f);
      const all = files.map((f) => out.get(f) ?? source.read(f)).join('\n');
      assert.equal(all.split('.spawnComputerUseService(').length - 1, 2, 'both calls (no relocation variable / with it) are in the one patched start function');
      assert.ok(!/execFile\)?\(`\/usr\/bin\/open`,\[[^\]]*(?:Computer Use|SkyComputerUse)/.test(all), 'nothing opens the helper through /usr/bin/open');
      // the addon (Resources/native/sky.node): posix_spawn with *_NSGetEnviron() (the process environment at call time), no private environment of its own
      const addon = readFileSync(join(APP, 'Contents', 'Resources', 'native', 'sky.node'));
      for (const needle of ['spawnComputerUseService', '__NSGetEnviron', '_posix_spawn', '_responsibility_spawnattrs_setdisclaim', 'SpawnComputerUseServiceWorker']) assert.ok(addon.includes(needle), `${needle} (the spawn is a Napi AsyncWorker: posix_spawn runs later on a worker thread, with the environment of that moment)`);
      for (const needle of ['NSProcessInfo', '_setenv', 'NSTask']) assert.ok(!addon.includes(needle), `${needle}: the addon would not follow the process environment`);
    });

    // m3 session 2, D3: why a QA copy with `[features] computer_use = false` still starts its helper. The managed service runs while ANY of
    // three desktop features is on; only computerUse follows the config key. Appshots and Chronicle (skysight) are statsig gates plus
    // requirements (system / MDM / cloud), with no per-profile switch. So the copy starts its own relocated helper with the private home.
    test('stock: the managed Computer Use service starts for Computer Use, appshots or Chronicle; only Computer Use follows features.computer_use', { skip: noStock() }, () => {
      const { source } = stock();
      const mainFile = pack.transforms.find((t) => t.id === 'cua-helper-private-home').file;
      const main = source.read(mainFile);
      assert.match(main, /get enabled\(\)\{return this\.appshotsEnabled\|\|this\.computerUseEnabled\|\|this\.skysightEnabled\}/, 'the service is enabled by any of the three');
      assert.match(main, /let ([\w$]+)=([\w$]+)\.appshotsEnabled,([\w$]+)=\2\.computerUse;[\w$]+\.setEnabledFeatures\(\{appshotsEnabled:\1,computerUseEnabled:\3,skysightEnabled:[\w$]+\}\)/, 'fed from the renderer\'s desktop features');
      assert.match(main, /let [\w$]+=[\w$]+\.skysight;/);
      const chunks = source.list('webview/assets/').filter((p) => p.endsWith('.js')).map((p) => source.read(p));
      const features = chunks.find((t) => t.includes('electron-desktop-features-changed`,{'));
      assert.ok(features, 'the renderer bundle that sends the desktop features');
      assert.match(features, /appshotsEnabled:[\w$]+,/);
      assert.match(features, /computerUse:[\w$]+\.available,/);
      assert.match(features, /skysight:[\w$]+\.available,/);
      // appshots: statsig gate 1304276663 and requirements.allowAppshots; Chronicle: gate 3488289778 and requirements.featureRequirements.chronicle
      // (the gates' chunk: the features' own up to 21477, another on 22943, where a Windows clause sits between the gate and the requirement)
      const APPSHOTS = /`1304276663`\)[^;]{0,400}requirements\?\.allowAppshots!==!1/, CHRONICLE = /[\w$]+\(`3488289778`\)[^]{0,600}requirements\?\.featureRequirements\?\.chronicle!==!1/;
      const appshots = chunks.find((t) => APPSHOTS.test(t)), chronicle = chunks.find((t) => CHRONICLE.test(t));
      assert.ok(appshots, 'appshots: statsig gate 1304276663 and requirements.allowAppshots');
      assert.ok(chronicle, 'Chronicle: statsig gate 3488289778 and requirements.featureRequirements.chronicle');
      // neither consults the computer_use feature: that key is read only for computerUse availability (featureName `computer_use`)
      for (const [gate, text] of [['1304276663', appshots], ['3488289778', chronicle]]) {
        const at = text.indexOf(`\`${gate}\``);
        assert.doesNotMatch(text.slice(Math.max(0, at - 400), at + 600), /computer_use/, gate);
      }
    });

    test('stock: after all transforms no "computer-use" path in the main-process bundles derives from codexHome without going through the relocation', { skip: noStock() }, () => {
      const { source } = stock();
      const out = applyAll(pack.transforms, (p) => source.read(p));
      const files = source.list('').filter((p) => /\.(m?js|cjs)$/.test(p) && !p.startsWith('webview/'));   // main, src, worker, bootstrap, preloads: every non-renderer script
      assert.ok(files.length > (stock().kind === 'asar' ? 100 : 30) && files.includes('.vite/build/worker.js'), 'every script of the app (an extraction keeps .vite/build, not the asar\'s node_modules)');
      const rows = (get) => files.flatMap((f) => remainingComputerUsePaths(get(f)).map((r) => ({ f, base: r.base })));
      // the checker sees every helper path of the stock app (dir, config writer, legacy approvals, installer) - it is not vacuous
      const relocations = mandatory.filter((t) => /^cua-relocate-(dir|config|installer|approvals)$/.test(t.id)).length;
      assert.equal(relocations, 4);
      assert.equal(rows((p) => source.read(p)).length, relocations);
      const mainFile = pack.transforms.find((t) => t.id === 'cua-relocate-dir').file;
      assert.equal(computerUsePaths(source.read(mainFile)).length, relocations + 1, 'the helper paths + the plugin skill file');
      // after the transforms only the bundled plugin's own skill file (join(pluginRoot, "skills", "computer-use", "SKILL.md")) remains
      assert.deepEqual(rows((p) => out.get(p) ?? source.read(p)), []);
      assert.ok(computerUsePaths(out.get(mainFile)).every((r) => /\.pluginRoot$/.test(r.base)) && computerUsePaths(out.get(mainFile)).length === 1);
      // and the relocations are in the patched main bundle; the stock sites of every mandatory edit in it are gone
      const main = out.get(mainFile);
      const ENV_USES = (t) => t.split('process.env.CODEX_MODS_COMPUTER_USE_DIR').length - 1;
      const written = ['cua-relocate-dir', 'cua-relocate-config', 'cua-relocate-installer', 'cua-relocate-approvals', 'cua-helper-private-home'].map((id) => ENV_USES(pack.transforms.find((t) => t.id === id).text));
      assert.ok(written.every((n) => n >= 1), 'dir, config writer, installer, legacy approvals, helper start (private CODEX_HOME) each read the directory');
      assert.equal(ENV_USES(main), written.reduce((a, n) => a + n, 0), 'and nothing else in the main bundle does');
      for (const t of mandatory.filter((x) => x.file === mainFile && x.op === 'replace-once')) assert.ok(!main.includes(t.find), `${t.id}: the stock site is gone`);
      // locked use: the installer cannot be executed from anywhere in the main process code, and the UI-visible results are the "unsupported" ones
      for (const f of files) assert.deepEqual(installerReachable(out.get(f) ?? source.read(f)), [], f);
      assert.ok(installerReachable(source.read(mainFile)).length >= 1, 'the checker sees the stock path: the resolver is called by the installer executor (22943: status and install both call the executor that holds the path)');
      for (const f of files) { const t = out.get(f) ?? source.read(f); if (t.includes(INSTALLER_NAME)) { assert.equal(f, mainFile); assert.equal(t.split(new RegExp(`[\`"']${INSTALLER_NAME}[\`"']`)).length - 1, 1, 'only the (dead) path array names the executable'); } }
      // a resolver function (21477) nothing calls; or (22943) the path inlined in the executor, which throws first (checked by installerReachable above)
      const resolver = /^function ([\w$]+)\(\)/.exec(pack.transforms.find((t) => t.id === 'cua-relocate-installer').text)?.[1];
      if (resolver) assert.ok(!new RegExp(`(?<![\\w$.])${resolver.replace(/\$/g, '\\$')}\\(\\)`).test(main.replace(`function ${resolver}()`, '')), `nothing calls the installer resolver ${resolver}()`);
      assert.ok(main.includes(pack.transforms.find((t) => t.id === 'cua-disable-locked-use').text));
      assert.ok(!main.includes('OK: installed'), 'the installer status protocol is gone');
    });
  }

  test('stock: every data-* attribute in an anchor selector exists in the stock renderer', { skip: noStock() }, () => {
    const { source } = stock();
    const wanted = new Set();
    for (const loc of Object.values(pack.anchors)) for (const s of loc.selectors) for (const m of s.matchAll(/\[(data-[\w-]+)/g)) wanted.add(m[1]);
    const files = source.list('webview/assets/').filter((p) => p.endsWith('.js') && !/\/[a-z]{2,3}(?:-[A-Za-z0-9]{2,4})?-[0-9a-f]{12}\.js$/.test('/' + p.split('/').pop()));
    const seen = new Set();
    for (const f of files) { const text = source.read(f); for (const a of wanted) if (!seen.has(a) && text.includes(a)) seen.add(a); if (seen.size === wanted.size) break; }
    assert.deepEqual([...wanted].filter((a) => !seen.has(a)), []);
  });

  const gated = pack.anchors['settings.section']?.selectors.every((x) => x.startsWith('body:has([data-settings-panel-slug="general-settings"][aria-current="page"])'));
  test('settings.section is gated on the General page being open: every locator carries the gate', { skip: !gated && 'this pack\'s settings.section is not gated' }, () => {
    assert.ok(gated);
    assert.ok(pack.anchors['settings.section'].selectors.length >= 1);
  });

  test('stock: the General page slug and the navigation entry\'s aria-current="page" the gate relies on exist in the stock renderer', { skip: noStock() || !gated }, () => {
    const { source } = stock();
    const files = source.list('webview/assets/').filter((p) => p.endsWith('.js'));
    const nav = files.map((f) => source.read(f)).filter((t) => t.includes('data-settings-panel-slug'));
    assert.ok(nav.length >= 1);
    assert.ok(nav.some((t) => t.includes('`general-settings.notifications.')), 'general-settings is the first slug of the Personal group');
    // the navigation row component takes `isActive` (with `excludeFromNavigation`) and renders aria-current="page" for the active row, located by its props, not by a name
    const entry = files.map((f) => source.read(f)).find((t) => {
      const props = /isActive:[\w$]+,[^{}]{0,200}?excludeFromNavigation:[\w$]+/.exec(t);
      const body = props ? t.slice(props.index, props.index + 12000) : '';
      return /[\w$]+\?`page`:void 0/.test(body) && body.includes('"aria-current":');
    });
    assert.ok(entry, 'the navigation row component sets aria-current="page" when isActive');
  });

  test('stock: every class token in an anchor selector appears in the stock renderer (settings frame: group/settings, data-density)', { skip: noStock() }, () => {
    const { source } = stock();
    const wanted = new Set();
    for (const loc of Object.values(pack.anchors)) for (const sel of loc.selectors) for (const m of sel.matchAll(/\[class~="([^"]+)"\]/g)) wanted.add(m[1]);
    if (!wanted.size) return;
    const files = source.list('webview/assets/').filter((p) => p.endsWith('.js') && source.size(p) > 100_000 && !/\/[a-z]{2,3}(?:-[A-Za-z0-9]{2,4})?-[0-9a-f]{12}\.js$/.test('/' + p.split('/').pop()));
    const seen = new Set();
    for (const f of files) { const text = source.read(f); for (const t of wanted) if (!seen.has(t) && text.includes(t)) seen.add(t); if (seen.size === wanted.size) break; }
    assert.deepEqual([...wanted].filter((t) => !seen.has(t)), []);
    // the settings frame renders both on the same element: a content column with class group/settings and a data-density attribute
    const frame = files.filter((f) => { const t = source.read(f); return t.includes('`group/settings ') && t.includes('"data-density":'); });
    assert.ok(frame.length >= 1, 'a chunk renders the group/settings column with data-density');
  });

  test('stock: every theme custom property is defined by the stock stylesheets, or set by the app\'s theme provider (the accent)', { skip: noStock() }, () => {
    const { source } = stock();
    const assets = source.list('webview/assets/');
    const css = assets.filter((p) => p.endsWith('.css')).map((p) => source.read(p)).join('\n');
    let js = null;   // the app's theme provider sets some on <html> from the user's theme: a style object's key
    const setByApp = (v) => (js ??= assets.filter((p) => p.endsWith('.js')).map((p) => source.read(p)).join('\n')).includes(`"${v}":`);
    for (const [token, v] of Object.entries(pack.theme)) assert.ok(css.includes(`${v}:`) || setByApp(v), `${token} → ${v} is never defined`);
  });

  test('stock: exposed components evaluate to real React and app components in a VM', { skip: noStock() || (!generated && 'the pack declares no component exposures') }, () => {
    const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', join(here, 'fixtures', 'vm-eval-shared.mjs'), ASAR, join(PACK_DIR, 'adapter.json')], { encoding: 'utf8', timeout: 110_000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(out.reactVersion, '19.2.7');
    assert.equal(out.createRoot, 'function'); assert.equal(out.createPortal, 'function');
    for (const k of ['Button', 'Switch', 'Dialog', 'Tooltip', 'Icon', 'SettingsRow', 'Menu']) assert.equal(out[k], 'function', k);
    assert.equal(out.MenuParts, 'object');
    assert.equal(out.DialogParts, 'object');
    if (hostSeams().length) { assert.equal(out.useScope, 'function'); assert.ok(['object', 'function'].includes(out.RouteScope), 'RouteScope ' + out.RouteScope); assert.ok(['object', 'function'].includes(out.ThreadScope), 'ThreadScope ' + out.ThreadScope); }
    assert.ok(Object.values(out.parsed).length >= 3 && Object.values(out.parsed).every((v) => v === true), JSON.stringify(out.parsed));
  });

}
