// Regenerates adapters/<version>-<bundle>/adapter.json for a stock app: the next build's pack is one run of this tool
// plus a review of NOTES.md "missing" items. Reads (never modifies) the stock app.
//   node adapters/tools/generate-adapter.mjs --app /Applications/ChatGPT.app --schema contracts/upstream/<build>/schema \
//        --authored adapters/<build>/authored.json --out adapters/<build>/adapter.json [--report report.json]
// Mandatory isolation edits (keychain Codey + Aura fallback, Computer Use container/identity, Computer Use relocation) are all-or-nothing: if any cannot
// be derived the tool exits 1 and writes NO pack. The pack lists their ids in `mandatoryEdits`.
// The UI seams (seams.mjs; docs/design/presentations.md V1) are derived too, as optional atomic groups after every other transform: a group that does not
// derive (or no longer applies after the transforms before it) is listed in the report as missing and the pack ships degraded; `seams.hooks` declares what applied.
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAsar } from './asar.mjs';
import { deriveTransforms, sourceFromAsar } from './derive.mjs';
import { protocolFromDir } from './protocol-from-schema.mjs';
import { deriveKeychainPatches } from './binary-patch.mjs';
import { deriveCuaContainerPatches } from './cua-container.mjs';
import { isMandatoryTransformId } from './transform.mjs';
import { applyUiSeams } from './seams.mjs';

/** Keychain-name (Codey) and Aura-fallback binary patches from whichever bundled framework binary carries Owl's OSCrypt name (fail closed: a miss is reported, never guessed). */
export function deriveFrameworkPatches(app) {
  const contents = join(app, 'Contents');
  const fwDir = join(contents, 'Frameworks');
  const errors = [];
  for (const fw of existsSync(fwDir) ? readdirSync(fwDir).filter((n) => n.endsWith('.framework')) : []) {
    const current = join(fwDir, fw, 'Versions', 'Current');
    if (!existsSync(current)) continue;
    const file = join(realpathSync(current), fw.slice(0, -'.framework'.length));
    if (!existsSync(file)) continue;
    // the binary's path inside the app, both sides resolved (an app reached through a link names the same file)
    try { return { patches: deriveKeychainPatches(readFileSync(file), relative(realpathSync(contents), file), { aura: true }), missing: [] }; } catch (e) { errors.push(`${fw}: ${e.message}`); }
  }
  return { patches: [], missing: [{ item: 'binaryPatches:keychain-service-name', mandatory: true, tried: errors.join('; ') || 'no framework binary found' }] };
}

export function readInfoPlist(plistPath) {
  const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', plistPath], { encoding: 'utf8' });
  return JSON.parse(json);
}

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/** Thrown by generate() when a mandatory isolation edit could not be derived. */
export class MandatoryEditsMissing extends Error {
  constructor(missing) {
    super(`refusing to emit a pack: mandatory isolation edits could not be derived: ${missing.map((m) => m.item).join(', ')}`);
    this.name = 'MandatoryEditsMissing';
    this.missing = missing;
  }
}

/** Ids of the mandatory isolation edits present in a pack (asar transforms starting `cua-` or `managed-config-`, and every binary patch). */
export function mandatoryEditIds(transforms, binaryPatches) {
  return [...transforms.filter((t) => isMandatoryTransformId(t.id)).map((t) => t.id), ...(binaryPatches ?? []).map((p) => p.id)];
}

/** Template variables the Host substitutes in `backend.configOverrides` strings (contracts/adapter.d.ts, v1.20). */
export const OVERRIDE_VARIABLES = Object.freeze(['appContents', 'resources', 'computerUseDir', 'codexHome', 'relayPath', 'profileDir']);
/** Keys the pack must declare once the managed config is no longer persisted (the baseline for the copy's own backend process). */
export const REQUIRED_OVERRIDES = Object.freeze(['notify', 'mcp_servers.node_repl']);

/** Problems with the declared `backend.configOverrides` (empty = fine): the required keys are present, values are TOML-shaped, every ${var} is a known variable. */
export function checkConfigOverrides(overrides) {
  const problems = [];
  if (overrides == null || typeof overrides !== 'object' || Array.isArray(overrides)) return ['backend.configOverrides is missing'];
  for (const key of REQUIRED_OVERRIDES) if (!(key in overrides)) problems.push(`backend.configOverrides has no "${key}"`);
  const walk = (v, where) => {
    if (typeof v === 'string') { for (const m of v.matchAll(/\$\{([^}]*)\}/g)) if (!OVERRIDE_VARIABLES.includes(m[1])) problems.push(`${where}: unknown template variable \${${m[1]}}`); }
    else if (typeof v === 'number' || typeof v === 'boolean') { /* fine */ }
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${where}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${where}.${k}`);
    else problems.push(`${where}: not a TOML-shaped value`);
  };
  for (const [k, v] of Object.entries(overrides)) { if (!/^[A-Za-z0-9_.-]+$/.test(k)) problems.push(`key "${k}" is not a dotted config path`); walk(v, k); }
  return problems;
}

export async function generate({ app, schema, authored }) {
  const info = readInfoPlist(join(app, 'Contents', 'Info.plist'));
  const asarPath = join(app, 'Contents', 'Resources', 'app.asar');
  const asar = openAsar(asarPath);
  try {
    const source = sourceFromAsar(asar);
    const pkg = JSON.parse(asar.read(authored.asarPackageJson).toString('utf8'));
    const derived = deriveTransforms(source);
    // The UI seams (docs/design/presentations.md V1) come after every other transform, as optional atomic groups: a group that does not derive, or no longer
    // applies after the transforms before it, is dropped and listed, and the pack ships degraded with what applied.
    const ui = applyUiSeams(source, derived.transforms);
    const transforms = ui.transforms;
    const uiMissing = ui.missing;
    const hooks = ui.hooks;
    const hostSeams = transforms.some((t) => t.id === 'seam-host:thread-header') ? { 'thread.header': { transform: 'seam-host:thread-header', exports: ['AppShell', 'RouteScope', 'ThreadScope', 'useScope'] }, 'thread.panel': { exports: ['registerTabType', 'rightPanel', 'SideChatTab', 'conversationManager', 'RouteScope', 'ThreadScope', 'useScope'] } } : {};
    const seams = { ...hostSeams, ...(hooks ? { hooks } : {}) };
    const fw = deriveFrameworkPatches(app);
    const cua = deriveCuaContainerPatches(join(app, 'Contents'));
    const bin = { patches: [...fw.patches, ...cua.patches], missing: [...fw.missing, ...cua.missing] };
    const mandatoryMissing = [...derived.missing, ...bin.missing].filter((m) => m.mandatory);
    // the managed config is no longer persisted, so the copy's own values must be declared as backend overrides: both halves or no pack
    const overrideProblems = checkConfigOverrides(authored.backend?.configOverrides);
    if (overrideProblems.length) mandatoryMissing.push({ item: 'backend.configOverrides', mandatory: true, tried: overrideProblems.join('; ') });
    if (mandatoryMissing.length) throw new MandatoryEditsMissing(mandatoryMissing);
    const electronVersion = String(pkg.devDependencies?.electron ?? '').replace(/^[^0-9]*/, '');
    const integrity = info.ElectronAsarIntegrity?.['Resources/app.asar']?.hash;
    if (integrity && integrity !== asar.headerSha256) throw new Error('app.asar header hash differs from Info.plist ElectronAsarIntegrity');
    const { _comment, ...rest } = authored;
    const pack = {
      adapterVersion: rest.adapterVersion,
      build: {
        version: info.CFBundleShortVersionString,
        bundleVersion: info.CFBundleVersion,
        asarSha256: await sha256File(asarPath),
        electronVersion,
      },
      backend: rest.backend,
      ...(rest.owl ? { owl: rest.owl } : {}),
      asarPackageJson: rest.asarPackageJson,
      protocol: protocolFromDir(schema),
      transforms,
      ...(bin.patches.length ? { binaryPatches: bin.patches } : {}),
      anchors: rest.anchors,
      components: derived.components,
      ...(Object.keys(seams).length ? { seams } : {}),
      react: derived.react,
      theme: rest.theme,
      mandatoryEdits: mandatoryEditIds(transforms, bin.patches),
    };
    return { pack, missing: [...derived.missing, ...bin.missing, ...uiMissing], evidence: { ...derived.evidence, uiSeams: { applied: ui.applied, exposures: ui.exposures.map((e) => `${e.key}@${e.role}`) } }, why: { ...derived.why, ...Object.fromEntries(ui.drafts.map((d) => [d.id, d.why])) }, asarHeaderSha256: asar.headerSha256 };
  } finally { asar.close(); }
}

/** CLI body, injectable for tests. Returns the exit code; writes the pack only when generate() succeeds. */
export async function main(argv, { generateFn = generate, write = writeFileSync, log = console.log, error = console.error } = {}) {
  const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const app = opt('app'); const schema = opt('schema'); const authoredPath = opt('authored'); const out = opt('out');
  if (!app || !schema || !authoredPath || !out) { error('usage: generate-adapter.mjs --app <App.app> --schema <dir> --authored <file> --out <file> [--report <file>]'); return 2; }
  let r;
  try { r = await generateFn({ app, schema, authored: JSON.parse(readFileSync(authoredPath, 'utf8')) }); } catch (e) {
    if (e instanceof MandatoryEditsMissing) {
      error(`${e.message}`);
      for (const m of e.missing) error(`  MANDATORY missing ${m.item}: ${m.tried}`);
      if (opt('report')) write(opt('report'), JSON.stringify({ refused: true, missing: e.missing }, null, 2) + '\n');
      return 1;
    }
    throw e;
  }
  write(out, JSON.stringify(r.pack, null, 2) + '\n');
  if (opt('report')) write(opt('report'), JSON.stringify({ missing: r.missing, evidence: r.evidence, why: r.why, asarHeaderSha256: r.asarHeaderSha256 }, null, 2) + '\n');
  log(`wrote ${out}: ${r.pack.transforms.length} transforms, ${r.pack.binaryPatches?.length ?? 0} binary patches, ${Object.keys(r.pack.components).length} components, ${r.missing.length} missing, ${r.pack.mandatoryEdits.length} mandatory edits`);
  for (const m of r.missing) log(`  missing ${m.item}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main(process.argv.slice(2)));
}
