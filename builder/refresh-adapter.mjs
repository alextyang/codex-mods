#!/usr/bin/env node
// Adapter refresh (ARCHITECTURE §12.3 step 2, §15): derive an adapter pack for a NEW stock build from the previous pack.
//
//   node builder/refresh-adapter.mjs --previous <adapter.json> --stock /Applications/ChatGPT.app --out <adapters/<build>>
//
// What it does (and records in refresh-report.json / NOTES.md, never silently):
//   * protocol   regenerated from the new binary's `app-server generate-json-schema` with adapters/tools/protocol-from-schema.mjs.
//                On failure the previous catalog is kept and the report says so.
//   * census     build-facts.json (adapters/tools/census.mjs, integration.md §9) from the new app.asar and both schemas (stable and
//                --experimental). A family that cannot anchor exactly is written as failed; a census that cannot run is reported, not fatal.
//   * transforms the MANDATORY isolation edits (ids `cua-*` and `managed-config-*`, ARCHITECTURE §5.3) are re-DERIVED from the new app.asar by the
//                adapters/tools derivers, which locate every site by string anchors and structure (never by a minified name or a chunk name) and
//                fail closed. They are never replayed from the previous pack. Every other transform's `find` is re-checked against the new
//                app.asar (exactly one occurrence; its file is resolved by role, i.e. the chunk name without its content hash). Surviving
//                transforms get new sha256Before/sha256After (chained per file, the way the builder applies them); a miss is DROPPED from the
//                pack (the builder aborts on any mismatch) and listed as missed. "Ship degraded rather than block." What the dropped
//                transforms provided (component exposures, host seams) is dropped from the pack's declarations with them, and listed.
//   * ui seams   the page seams (docs/design/presentations.md V1: JSX, lazy, the three command taps, the AppHost hold, one exposure block per renderer chunk) are
//                DERIVED again from the new app.asar by adapters/tools/seams.mjs, as optional atomic groups after every other transform; a previous pack's
//                transforms of these kinds are never replayed (their finds embed content hashes and minified names). A group that does not derive, or no
//                longer applies exactly once after the transforms before it, is dropped and listed (report.uiSeams, NOTES.md), and the pack's
//                `seams.hooks` declares only what applied.
//   * anchors    every selector's literal tokens (attribute values, classes, ids) are searched in the new bundle text. A selector
//                that cannot be verified statically (tag-only) is "unverified"; an anchor whose selectors all missed is "missed".
//                The pack keeps all anchors: the runtime probe (ProbeReport) is the final judge.
//   * binaryPatches re-derived for the new binaries with the adapters/tools derivers (keychain names, Computer Use container); the previous
//                pack's patches are NEVER carried forward (their hashes and offsets belong to the old build).
//   * mandatory  every id in previous.mandatoryEdits (keychain/Computer Use isolation; ids that embedded a chunk name are read by role,
//                `cua-bundle-id:main-CqEoQDOU.js:1` = `cua-bundle-id:main:1`) must be present in the refreshed transforms or
//                binaryPatches; otherwise NO pack is written and the refresh fails (contracts v1.13).
// Node built-ins only.
import { open, readFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CodexModsError } from '../sdk/errors.mjs';
import { readAppBuildSync, exists } from '../framework/host/recovery/support.mjs';
import { ISOLATION_BASELINE_IDS, ISOLATION_BASELINE_PREFIXES, isolationBaselineMissing } from './build.mjs';
import { openAsar as openSyncAsar } from '../adapters/tools/asar.mjs';
import { sourceFromAsar } from '../adapters/tools/derive.mjs';
import { fileStem, normalizeEditId, isMandatoryTransformId } from '../adapters/tools/transform.mjs';
import { deriveUiSeams, declarationFor, isUiSeam } from '../adapters/tools/seams.mjs';

const TREE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
/** Seams whose transforms only work together (the trusted-sender trio): a refresh keeps all of them or none. */
const ATOMIC_SEAMS = ['trusted-sender'];

// ------------------------------------------------------------------ minimal asar reader
/** Opens an asar for reading. Header layout: u32 4, u32 headerSize, u32 jsonPickleSize, u32 jsonLength, JSON; data at 8 + headerSize. */
export async function openAsar(path) {
  const fh = await open(path, 'r');
  try {
    const head = Buffer.alloc(16);
    await fh.read(head, 0, 16, 0);
    const headerSize = head.readUInt32LE(4);
    const jsonLength = head.readUInt32LE(12);
    const json = Buffer.alloc(jsonLength);
    await fh.read(json, 0, jsonLength, 16);
    const header = JSON.parse(json.toString('utf8'));
    const base = 8 + headerSize;
    const node = (p) => p.split('/').filter(Boolean).reduce((n, part) => n?.files?.[part], header);
    return {
      files() {
        const out = [];
        const walk = (n, prefix) => {
          for (const [name, child] of Object.entries(n.files ?? {})) {
            const p = prefix ? `${prefix}/${name}` : name;
            if (child.files) walk(child, p); else if (child.offset !== undefined || child.unpacked) out.push([p, child]);
          }
        };
        walk(header, '');
        return out;
      },
      has(p) { const n = node(p); return !!n && n.files === undefined; },
      async read(p) {
        const n = node(p);
        if (!n || n.files !== undefined) return null;
        if (n.unpacked) return readFile(join(`${path}.unpacked`, p));
        const buf = Buffer.alloc(n.size);
        await fh.read(buf, 0, n.size, base + Number(n.offset));
        return buf;
      },
      close: () => fh.close(),
    };
  } catch (e) { await fh.close(); throw e; }
}

const sha256File = (path) => new Promise((res, rej) => {
  const h = createHash('sha256'); const s = createReadStream(path);
  s.on('data', (d) => h.update(d)); s.once('error', rej); s.once('end', () => res(h.digest('hex')));
});

// ------------------------------------------------------------------ transforms
function applyTransform(text, t) {
  const first = text.indexOf(t.find);
  if (first < 0) return { count: 0 };
  const count = text.split(t.find).length - 1;
  if (count !== 1) return { count };
  const end = first + t.find.length;
  const out = t.op === 'replace-once' ? text.slice(0, first) + t.text + text.slice(end)
    : t.op === 'insert-before-once' ? text.slice(0, first) + t.text + text.slice(first)
      : text.slice(0, end) + t.text + text.slice(end);
  return { count: 1, out };
}

/**
 * The file in the new asar that plays the role of a previous transform's file: the same name when it exists, else the one file in the same
 * directory with the same extension and the same name without its content hash (`main-CqEoQDOU.js` -> `main-CLu1A25j.js`). Null when none or several.
 */
export function resolveBuildFile(asar, file) {
  if (asar.has(file)) return file;
  const dir = file.split('/').slice(0, -1).join('/');
  const ext = /\.[^./]+$/.exec(file)?.[0];
  const stem = fileStem(file);
  const hits = asar.files().map(([p]) => p).filter((p) => p.split('/').slice(0, -1).join('/') === dir && p.endsWith(ext ?? '') && fileStem(p) === stem);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Default deriver of the mandatory asar edits (Computer Use relocation, identity and container, locked-use removal, managed config, no CUA skill
 * exposure in the shared plugin cache, the Computer Use socket peer authorization of N9): the
 * adapters/tools derivers over a sync source of the new app.asar. They return `{ drafts, missing }`; any `missing` entry is a failed refresh.
 */
export async function deriveMandatoryTransforms(source) {
  try {
    const { deriveCuaContainerTransform } = await import(pathToFileURL(join(TREE, 'adapters', 'tools', 'cua-container.mjs')).href);
    const { deriveManagedConfigTransforms } = await import(pathToFileURL(join(TREE, 'adapters', 'tools', 'managed-config.mjs')).href);
    const { deriveCuaSkillsTransform } = await import(pathToFileURL(join(TREE, 'adapters', 'tools', 'cua-skills.mjs')).href);
    const { deriveCuaPeerAuthTransform } = await import(pathToFileURL(join(TREE, 'adapters', 'tools', 'cua-peer-auth.mjs')).href);
    const cua = deriveCuaContainerTransform(source); const managed = deriveManagedConfigTransforms(source); const skills = deriveCuaSkillsTransform(source); const peer = deriveCuaPeerAuthTransform(source);
    return { drafts: [...cua.drafts, ...managed.drafts, ...skills.drafts, ...peer.drafts], missing: [...cua.missing, ...managed.missing, ...skills.missing, ...peer.missing] };
  } catch (e) { return { drafts: [], missing: [{ item: 'transform:mandatory', mandatory: true, tried: `deriver failed: ${String(e.message).split('\n')[0]}` }] }; }
}

/** Default deriver of the UI seams: adapters/tools/seams.mjs over a sync source of the new app.asar. A failure to run is a finding (all groups missing), never fatal. */
export async function deriveUiSeamGroups(source) {
  try { return deriveUiSeams(source); } catch (e) { return { groups: [], drafts: [], exposures: [], missing: [{ item: 'seams', tried: `deriver failed: ${String(e.message).split('\n')[0]}` }] }; }
}

/**
 * The pack's declarations that depend on transforms: components and react are exposed by the 'components' transforms (their text lists the exposed keys),
 * and each host seam by its own transform plus those keys. Whatever the surviving transforms no longer provide is dropped (a pack never declares
 * what its transforms do not deliver) and reported.
 */
export function reconcileDeclarations(previous, transforms) {
  const exposed = new Set(transforms.filter((t) => t.seam === 'components').flatMap((t) => [...t.text.matchAll(/"([\w$]+)":\(\)=>/g)].map((m) => m[1])));
  const components = Object.fromEntries(Object.entries(previous.components ?? {}).filter(([, key]) => exposed.has(key)));
  const react = previous.react && exposed.has(previous.react.react) && exposed.has(previous.react.reactDom) ? previous.react : null;
  // `hooks` (the UI seams) is not a surface host: it is declared again from the transforms that applied (declarationFor), never carried over
  const hostSeams = Object.entries(previous.seams ?? {}).filter(([k]) => k !== 'hooks');
  const seams = Object.fromEntries(hostSeams.filter(([, s]) =>
    (s.transform === undefined || transforms.some((t) => t.id === s.transform)) && s.exports.every((k) => exposed.has(k))));
  return { components, react, seams, report: {
    components: Object.keys(previous.components ?? {}).filter((k) => !(k in components)),
    react: !!previous.react && !react,
    seams: hostSeams.map(([k]) => k).filter((k) => !(k in seams)),
  } };
}

/** `value` with every string that is exactly the previous build's version replaced by the new one; the paths changed are appended to `hits`. */
export function retargetVersion(value, from, to, where, hits) {
  if (typeof value === 'string') { if (value !== from) return value; hits.push(where); return to; }
  if (Array.isArray(value)) return value.map((v, i) => retargetVersion(v, from, to, `${where}[${i}]`, hits));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, retargetVersion(v, from, to, `${where}.${k}`, hits)]));
  return value;
}

// ------------------------------------------------------------------ anchors
/** Literal tokens a selector needs in the bundle: attribute names/values, classes, ids. Tag-only selectors yield none. */
export function selectorTokens(selector) {
  const tokens = new Set();
  for (const m of selector.matchAll(/\[\s*([\w-]+)\s*(?:[~|^$*]?=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]/g)) {
    const value = m[2] ?? m[3] ?? m[4];
    tokens.add(value !== undefined && value !== '' ? value : m[1]);
  }
  const rest = selector.replace(/\[[^\]]*\]/g, ' ');
  for (const m of rest.matchAll(/(?<!\\)[.#]([A-Za-z_][\w-]*)/g)) tokens.add(m[1]);
  return [...tokens];
}
const TEXT_FILE = /\.(?:js|mjs|cjs|html|css|json)$/i;
async function findTokens(asar, wanted, { maxFileBytes = 40 * 1024 * 1024 } = {}) {
  const remaining = new Set(wanted);
  for (const [p, n] of asar.files()) {
    if (remaining.size === 0) break;
    if (!TEXT_FILE.test(p) || (n.size ?? 0) > maxFileBytes) continue;
    const text = (await asar.read(p))?.toString('utf8');
    if (!text) continue;
    for (const tok of remaining) if (text.includes(tok)) remaining.delete(tok);
  }
  return new Set([...wanted].filter((t) => !remaining.has(t)));
}

// ------------------------------------------------------------------ binary patches
/** Default deriver: the keychain-name patch in the Owl framework binary and the Computer Use container patches, via adapters/tools. */
export async function deriveBinaryPatches(stockApp) {
  const missing = [];
  const patches = [];
  try {
    const { deriveFrameworkPatches } = await import(pathToFileURL(join(TREE, 'adapters', 'tools', 'generate-adapter.mjs')).href);
    const fw = deriveFrameworkPatches(stockApp);
    patches.push(...fw.patches); missing.push(...fw.missing);
  } catch (e) { missing.push({ item: 'binaryPatches:keychain-service-name', tried: `deriver unavailable: ${String(e.message).split('\n')[0]}` }); }
  try {
    const { deriveCuaContainerPatches } = await import(pathToFileURL(join(TREE, 'adapters', 'tools', 'cua-container.mjs')).href);
    const cua = deriveCuaContainerPatches(join(stockApp, 'Contents'));
    patches.push(...cua.patches); missing.push(...cua.missing);
  } catch (e) { missing.push({ item: 'binaryPatches:cua-container', tried: `deriver unavailable: ${String(e.message).split('\n')[0]}` }); }
  return { patches, missing };
}

// ------------------------------------------------------------------ protocol
const defaultRunCodex = (codex, args, env) => new Promise((res, rej) =>
  execFile(codex, args, { env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (e, out, err) => (e ? rej(new Error(`${e.message}\n${err}`.trim())) : res(out))));
async function loadProtocolTool(path) {
  const mod = await import(pathToFileURL(path).href);
  // The generator takes the schema directory: protocolFromDir is the tool's directory entry point (buildProtocol takes a reader function).
  const fn = mod.protocolFromSchema ?? mod.protocolFromDir ?? mod.generateProtocol ?? mod.default;
  if (typeof fn !== 'function') throw new Error(`${path} exports no generator function (expected protocolFromSchema)`);
  return fn;
}
async function regenerateProtocol({ previous, stockApp, runCodex, protocolFromSchema, protocolTool, asarPath, runCensus }) {
  const dir = join(tmpdir(), `codexmods-schema-${randomBytes(4).toString('hex')}`);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const home = join(dir, 'codex-home');
    await mkdir(home, { mode: 0o700 });
    const out = join(dir, 'schema');
    const codex = join(stockApp, 'Contents', previous.backend.codexPath);
    // Isolated CODEX_HOME (and HOME) so the schema command never reads or writes the user's ~/.codex.
    await (runCodex ?? defaultRunCodex)(codex, ['app-server', 'generate-json-schema', '--out', out], { ...process.env, HOME: home, CODEX_HOME: home });
    const gen = protocolFromSchema ?? await loadProtocolTool(protocolTool ?? join(TREE, 'adapters', 'tools', 'protocol-from-schema.mjs'));
    const catalog = await gen(out, { previous: previous.protocol });
    if (!catalog?.methods) throw new Error('the generator returned no protocol catalog');
    const counts = Object.fromEntries(Object.entries(catalog.methods).map(([k, v]) => [k, v.length]));
    // The census (integration.md §9) needs the experimental schema too; its failure never fails the refresh, it is reported.
    let facts = null, census = { written: false };
    try {
      const exp = join(dir, 'schema-experimental');
      await (runCodex ?? defaultRunCodex)(codex, ['app-server', 'generate-json-schema', '--experimental', '--out', exp], { ...process.env, HOME: home, CODEX_HOME: home });
      facts = (runCensus ?? (await import(pathToFileURL(join(TREE, 'adapters', 'tools', 'census.mjs')).href)).census)(asarPath, out, exp);
      for (const f of Object.values(facts.families)) delete f.ms;
      delete facts.runtimeMs;
      census = { written: true, failed: Object.entries(facts.families).filter(([, f]) => f.status !== 'ok').map(([id]) => id) };
    } catch (e) { census = { written: false, reason: String(e.message).split('\n')[0] }; }
    return { catalog, facts, report: { regenerated: true, counts, census } };
  } catch (e) {
    return { catalog: previous.protocol, report: { regenerated: false, reason: String(e.message).split('\n')[0] } };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

// ------------------------------------------------------------------ refresh
/**
 * @param {{ previous?: object, previousPath?: string, stockApp: string, outDir: string, log?: object,
 *   runCodex?: Function, deriveBinaryPatches?: Function, deriveMandatoryTransforms?: (source) => Promise<{drafts: object[], missing: object[]}>, allowNoBaseline?: boolean, protocolFromSchema?: Function, protocolTool?: string, now?: () => string }} opts
 * @returns {Promise<{adapterPath: string, adapter: object, report: object}>}
 */
export async function refreshAdapter(opts) {
  const { stockApp, outDir } = opts;
  const previous = opts.previous ?? JSON.parse(await readFile(opts.previousPath, 'utf8'));
  if (await exists(outDir)) throw new CodexModsError('Conflict', `${outDir} already exists`);
  const build = readAppBuildSync(stockApp);
  const asarPath = join(stockApp, 'Contents', 'Resources', 'app.asar');
  const asar = await openAsar(asarPath);
  const tmp = join(dirname(outDir), `.refresh-${randomBytes(4).toString('hex')}`);
  try {
    // transforms, chained per file the way the builder applies them
    const work = new Map();
    const transforms = []; const tReport = {};
    const current = async (file) => { if (!work.has(file)) work.set(file, await asar.read(file)); return work.get(file); };

    // 1. every transform that is not a mandatory isolation edit is replayed: its file resolved by role, its `find` present exactly once.
    // A seam that only works whole (the trusted sender) is dropped whole: when one of its transforms is lost, so are the others.
    let firstPass = {};
    const replay = async (skipSeams) => {
      work.clear(); transforms.length = 0; for (const k of Object.keys(tReport)) delete tReport[k];
      for (const t of previous.transforms ?? []) {
        if (isMandatoryTransformId(t.id) || isUiSeam(t)) continue;           // re-derived below, never replayed
        if (skipSeams.has(t.seam)) { tReport[t.id] = firstPass[t.id]?.missed ? firstPass[t.id] : { missed: true, reason: `another transform of the ${t.seam} seam is missing, and the seam works only whole` }; continue; }
        const file = await resolveBuildFile(asar, t.file);
        const buf = file ? await current(file) : null;
        if (!buf) { tReport[t.id] = { missed: true, reason: 'file not found in the new bundle' }; continue; }
        const res = applyTransform(buf.toString('utf8'), t);
        if (res.count !== 1) { tReport[t.id] = { missed: true, reason: res.count === 0 ? '`find` not found in the new bundle' : `\`find\` occurs ${res.count} times in the new bundle` }; continue; }
        const out = Buffer.from(res.out, 'utf8');
        transforms.push({ ...t, file, sha256Before: sha256(buf), sha256After: sha256(out) });
        work.set(file, out);
        tReport[t.id] = file === t.file ? { missed: false } : { missed: false, file };
      }
    };
    await replay(new Set());
    const wholeSeams = new Set((previous.transforms ?? []).filter((t) => ATOMIC_SEAMS.includes(t.seam) && tReport[t.id]?.missed).map((t) => t.seam));
    if (wholeSeams.size) { firstPass = { ...tReport }; await replay(wholeSeams); }

    // 2. the mandatory isolation edits are derived from the new asar (string anchors and structure, fail closed). The previous pack only says WHICH
    // edits are required (by role id); where they sit, and their finds and texts, are re-derived for this build.
    // A bundle-id edit is one site of a family (`cua-bundle-id:<role>:<n>`): how many sites a build has, and in which chunks, is the build's
    // (22943 split its main process into numbered chunks). The family is required whole instead: the baseline's `cua-bundle-id:` prefix, and the
    // deriver's dry run over every .vite/build file, which fails when any stock helper id is left.
    const isBundleIdSite = (id) => /^cua-bundle-id:.+:\d+$/.test(id);
    const previousMandatoryAll = (previous.transforms ?? []).filter((t) => isMandatoryTransformId(t.id)).map((t) => normalizeEditId(t.id));
    const previousTransformEdits = previousMandatoryAll.filter((id) => !isBundleIdSite(id));
    const previousMandatory = [...new Set([...(previous.mandatoryEdits ?? []).map(normalizeEditId).filter((id) => !isBundleIdSite(id)), ...previousTransformEdits])];
    // the families the previous pack had sites of: each must have at least one site in this build
    const previousFamilies = [...new Set([...(previous.mandatoryEdits ?? []), ...previousMandatoryAll].map(normalizeEditId).filter(isBundleIdSite).map(() => 'cua-bundle-id:'))];
    let derivedMissing = [];
    const sync = openSyncAsar(asarPath);
    let uiDerived;
    try {
      uiDerived = await (opts.deriveUiSeams ?? deriveUiSeamGroups)(sourceFromAsar(sync));
    } catch (e) { uiDerived = { groups: [], missing: [{ item: 'seams', tried: `deriver failed: ${String(e.message).split('\n')[0]}` }] }; } finally { sync.close(); }
    if (!opts.allowNoBaseline || previousMandatoryAll.length) {
      const sync2 = openSyncAsar(asarPath);
      let derived;
      try { derived = await (opts.deriveMandatoryTransforms ?? deriveMandatoryTransforms)(sourceFromAsar(sync2)); } finally { sync2.close(); }
      derivedMissing = derived.missing ?? [];
      for (const d of derived.drafts ?? []) {
        const buf = await current(d.file);
        const res = buf ? applyTransform(buf.toString('utf8'), d) : { count: 0 };
        if (res.count !== 1) { tReport[d.id] = { missed: true, reason: buf ? `the derived \`find\` occurs ${res.count} times after the other transforms of ${d.file}` : `${d.file} not found in the new bundle` }; continue; }
        const out = Buffer.from(res.out, 'utf8');
        transforms.push({ id: d.id, seam: d.seam, file: d.file, sha256Before: sha256(buf), sha256After: sha256(out), op: d.op, find: d.find, text: d.text });
        work.set(d.file, out);
        tReport[d.id] = { missed: false, derived: true };
      }
      const tried = derivedMissing.map((m) => `${m.item}: ${m.tried}`).join('; ');
      for (const id of previousTransformEdits) if (!tReport[id]) tReport[id] = { missed: true, reason: `not derived for this build${tried ? ` (${tried})` : ''}` };
    }

    // 2b. the UI seams: optional atomic groups after every other transform (so the mandatory edits keep their hashes). A group applies whole or not at all.
    const uiReport = { applied: [], dropped: [], missing: uiDerived.missing ?? [], previous: (previous.transforms ?? []).filter(isUiSeam).map((t) => t.id) };
    for (const g of uiDerived.groups ?? []) {
      const staged = new Map(); const sealed = []; let why = null;
      for (const d of g.drafts) {
        const buf = staged.get(d.file) ?? await current(d.file);
        const res = buf ? applyTransform(buf.toString('utf8'), d) : { count: 0 };
        if (res.count !== 1) { why = buf ? `\`find\` occurs ${res.count} times after the transforms before it in ${d.file}` : `${d.file} not found in the new bundle`; break; }
        const out = Buffer.from(res.out, 'utf8');
        sealed.push({ id: d.id, seam: d.seam, file: d.file, sha256Before: sha256(buf), sha256After: sha256(out), op: d.op, find: d.find, text: d.text });
        staged.set(d.file, out);
      }
      if (why) { uiReport.dropped.push({ id: g.id, why }); for (const d of g.drafts) tReport[d.id] = { missed: true, reason: `the ${g.id} group no longer applies: ${why}`, uiSeam: true }; continue; }
      for (const [f, b] of staged) work.set(f, b);
      transforms.push(...sealed);
      for (const x of sealed) tReport[x.id] = { missed: false, derived: true, uiSeam: true };
      uiReport.applied.push(g.id);
    }
    for (const id of uiReport.previous) if (!tReport[id]) tReport[id] = { missed: true, reason: 'not derived for this build (the UI seams are derived again for every build)', uiSeam: true };

    // anchors
    const aReport = {};
    const perSelector = new Map();
    for (const loc of Object.values(previous.anchors ?? {})) for (const s of loc.selectors) perSelector.set(s, selectorTokens(s));
    const found = await findTokens(asar, new Set([...perSelector.values()].flat()));
    for (const [name, loc] of Object.entries(previous.anchors ?? {})) {
      const selectors = loc.selectors.map((s) => {
        const toks = perSelector.get(s);
        return { selector: s, status: toks.length === 0 ? 'unverified' : toks.every((t) => found.has(t)) ? 'found' : 'missed' };
      });
      aReport[name] = { missed: selectors.every((s) => s.status === 'missed'), selectors };
    }

    // protocol
    const proto = await regenerateProtocol({ previous, stockApp, runCodex: opts.runCodex, protocolFromSchema: opts.protocolFromSchema, protocolTool: opts.protocolTool, asarPath, runCensus: opts.runCensus });

    // binary patches: derived afresh for this build, never carried forward
    const bin = await (opts.deriveBinaryPatches ?? deriveBinaryPatches)(stockApp);

    // mandatory isolation edits: no pack at all when one is missing. The requirement is the previous pack's list (read by role) PLUS the fixed
    // isolation baseline (ARCHITECTURE v1.14), so an older pack without the field cannot be refreshed into a pack without the guarantees.
    const have = new Set([...transforms.map((t) => t.id), ...bin.patches.map((p) => p.id)]);
    const declared = [...new Set([...previousMandatory, ...transforms.map((t) => t.id).filter(isMandatoryTransformId)])];
    const mandatoryOut = opts.allowNoBaseline ? declared : [...new Set([...declared, ...ISOLATION_BASELINE_IDS,
      ...[...have].filter((id) => ISOLATION_BASELINE_PREFIXES.some((p) => id.startsWith(p)))])];
    const missingMandatory = [...mandatoryOut.filter((id) => !have.has(id)),
      ...previousFamilies.filter((prefix) => ![...have].some((id) => id.startsWith(prefix))).map((prefix) => `${prefix}*`)];
    const candidate = { mandatoryEdits: mandatoryOut.filter((id) => have.has(id)), transforms, binaryPatches: bin.patches };
    const baselineMissing = opts.allowNoBaseline ? [] : isolationBaselineMissing(candidate);
    const derivationFailed = derivedMissing.filter((m) => m.mandatory !== false);
    if (missingMandatory.length || baselineMissing.length || derivationFailed.length) {
      const why = [...Object.entries(tReport).filter(([id, v]) => v.missed && missingMandatory.includes(id)).map(([id, v]) => `${id}: ${v.reason}`),
        ...derivedMissing.map((m) => `${m.item}: ${m.tried}`), ...bin.missing.map((m) => `${m.item}: ${m.tried}`)];
      const list = [...new Set([...missingMandatory, ...baselineMissing, ...derivationFailed.map((m) => m.item)])];
      throw new CodexModsError('Incompatible', `refusing to write an adapter pack for ${build.build}: mandatory isolation edit(s) missing: ${list.join(', ')}${why.length ? ` (${[...new Set(why)].join('; ')})` : ''}`, { missing: list, why });
    }

    // What the dropped transforms provided (component exposures, host seams) leaves the pack's declarations with them.
    const declarations = reconcileDeclarations(previous, transforms);

    // The Electron version is not in any plist of this app family; the previous pack's value is kept (builder probes own it).
    const electronVersion = previous.build.electronVersion;

    const baseVersion = String(previous.adapterVersion).split('+')[0];
    const adapter = {
      ...previous,
      adapterVersion: `${baseVersion}+refresh.${build.bundle}`,
      build: { version: build.short, bundleVersion: build.bundle, asarSha256: await sha256File(asarPath), electronVersion },
      protocol: proto.catalog,
      transforms,
      components: declarations.components,
      react: declarations.react,
    };
    // host seams survive as far as their transforms do; `hooks` declares exactly the UI seams that applied (ABI of the hook names included)
    const hooks = declarationFor(transforms);
    const seams = { ...declarations.seams, ...(hooks ? { hooks } : {}) };
    if (Object.keys(seams).length) adapter.seams = seams; else delete adapter.seams;
    // the backend overrides name the app version they were declared for (node_repl's BROWSER_USE_CODEX_APP_VERSION): they follow the pack's build
    const retargeted = [];
    if (previous.backend?.configOverrides) adapter.backend = { ...previous.backend, configOverrides: retargetVersion(previous.backend.configOverrides, previous.build.version, build.short, 'backend.configOverrides', retargeted) };
    adapter.mandatoryEdits = mandatoryOut;
    if (!adapter.mandatoryEdits.length) delete adapter.mandatoryEdits;
    delete adapter.binaryPatches;
    if (bin.patches.length) adapter.binaryPatches = bin.patches;
    const report = {
      generatedAt: (opts.now ?? (() => new Date().toISOString()))(),
      from: `${previous.build.version}-${previous.build.bundleVersion}`, to: build.build,
      transforms: tReport, anchors: aReport, protocol: proto.report,
      binaryPatches: { derived: bin.patches.length, previous: (previous.binaryPatches ?? []).length, missing: bin.missing },
      declarations: declarations.report,
      uiSeams: { ...uiReport, declared: hooks ?? null },
      retargetedOverrides: retargeted,
      mandatoryEdits: mandatoryOut,
    };
    await mkdir(tmp, { recursive: true, mode: 0o700 });
    await writeFile(join(tmp, 'adapter.json'), JSON.stringify(adapter, null, 2) + '\n', { mode: 0o600 });
    await writeFile(join(tmp, 'refresh-report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    await writeFile(join(tmp, 'NOTES.md'), notes(report), { mode: 0o600 });
    if (proto.facts) await writeFile(join(tmp, 'build-facts.json'), JSON.stringify(proto.facts, null, 1) + '\n', { mode: 0o600 });
    await rename(tmp, outDir);
    return { adapterPath: join(outDir, 'adapter.json'), adapter, report };
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    throw e;
  } finally { await asar.close(); }
}

function notes(r) {
  const lines = [`# Refreshed adapter pack ${r.to}`, '', `Derived from ${r.from} on ${r.generatedAt}. Review everything marked missed; none of it was guessed.`, ''];
  const missedT = Object.entries(r.transforms).filter(([, v]) => v.missed && !v.uiSeam);
  const derivedT = Object.entries(r.transforms).filter(([, v]) => v.derived && !v.uiSeam).map(([k]) => k);
  lines.push('## Transforms', '', ...(derivedT.length ? [`- mandatory isolation edits derived from this build's app.asar (not replayed): ${derivedT.join(', ')}`] : []),
    ...(missedT.length ? missedT.map(([k, v]) => `- missed ${k}: ${v.reason} (dropped from the pack)`) : ['- no transform missed']), '');
  if (r.uiSeams) {
    const u = r.uiSeams;
    lines.push('## UI seams', '', `- derived again for this build and applied (atomic groups): ${u.applied.length ? u.applied.join(', ') : 'none'}`,
      ...u.dropped.map((d) => `- dropped group ${d.id}: ${d.why}`), ...u.missing.map((m) => `- did not derive ${m.item}: ${m.tried}`),
      u.declared ? `- declared in seams.hooks (abi ${u.declared.abi}): ${Object.keys(u.declared).filter((k) => k !== 'abi').join(', ')}` : '- nothing declared: the pack ships without UI seams', '');
  }
  const dropped = r.declarations ?? {};
  const droppedLines = [...(dropped.components?.length ? [`- components no longer exposed, dropped from the pack: ${dropped.components.join(', ')}`] : []),
    ...(dropped.react ? ['- react/reactDom no longer exposed, dropped from the pack'] : []),
    ...(dropped.seams?.length ? [`- host seams no longer provided, dropped from the pack: ${dropped.seams.join(', ')}`] : [])];
  if (droppedLines.length) lines.push('## Declarations', '', ...droppedLines, '');
  if (r.retargetedOverrides?.length) lines.push('## Backend overrides', '', `- the previous build's app version was replaced by ${r.to.split('-')[0]} in: ${r.retargetedOverrides.join(', ')}`, '');
  const missedA = Object.entries(r.anchors).filter(([, v]) => v.missed);
  const unver = Object.entries(r.anchors).filter(([, v]) => !v.missed && v.selectors.some((s) => s.status !== 'found'));
  lines.push('## Anchors', '', ...(missedA.length ? missedA.map(([k]) => `- missed ${k}: no selector found in the bundle`) : ['- no anchor fully missed']),
    ...unver.map(([k, v]) => `- ${k}: ${v.selectors.filter((s) => s.status !== 'found').map((s) => `${s.selector} (${s.status})`).join(', ')}`), '');
  lines.push('## Binary patches', '', `- re-derived for this build: ${r.binaryPatches.derived} (previous pack had ${r.binaryPatches.previous}; none carried forward)`, ...r.binaryPatches.missing.map((m) => `- missing ${m.item}: ${m.tried}`), r.mandatoryEdits.length ? `- mandatory edits all present: ${r.mandatoryEdits.join(', ')}` : '- the previous pack lists no mandatory edits', '');
  lines.push('## Protocol', '', r.protocol.regenerated ? `- regenerated: ${JSON.stringify(r.protocol.counts)}` : `- NOT regenerated: ${r.protocol.reason} (previous catalog kept)`, '');
  if (r.protocol.census) lines.push('## Census', '', r.protocol.census.written ? `- build-facts.json written; families that failed to anchor: ${r.protocol.census.failed.length ? r.protocol.census.failed.join(', ') : 'none'}` : `- NOT written: ${r.protocol.census.reason}`, '');
  return lines.join('\n');
}

// ------------------------------------------------------------------ CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i < 0 ? undefined : process.argv[i + 1]; };
  const previousPath = arg('--previous'), stockApp = arg('--stock') ?? '/Applications/ChatGPT.app', outDir = arg('--out');
  if (!previousPath || !outDir) { console.error('usage: refresh-adapter.mjs --previous <adapter.json> [--stock <app>] --out <dir>'); process.exit(64); }
  refreshAdapter({ previousPath, stockApp, outDir }).then((r) => {
    const t = Object.values(r.report.transforms).filter((v) => v.missed).length;
    const a = Object.values(r.report.anchors).filter((v) => v.missed).length;
    console.log(`wrote ${r.adapterPath} (missed transforms: ${t}, missed anchors: ${a}, protocol regenerated: ${r.report.protocol.regenerated})`);
  }, (e) => { console.error(`${e.code ?? 'Error'}: ${e.message}`); process.exit(e.code === 'Incompatible' ? 3 : 1); });   // 3: a mandatory edit cannot be derived
}
