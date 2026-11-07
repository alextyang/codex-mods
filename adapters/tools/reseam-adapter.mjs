#!/usr/bin/env node
// Derives the UI seams (seams.mjs; docs/design/presentations.md V1) again for an EXISTING pack of the same build, without a refresh:
//
//   node adapters/tools/reseam-adapter.mjs --pack adapters/<build>/adapter.json [--stock <app.asar | extracted dir>] [--out <adapter.json>] [--report <file>]
//
// What it does, and nothing else:
//   * proves the stock source is the pack's build: every non-UI transform of the pack applies to it with the hashes the pack records (the
//     mandatory isolation edits and the other transforms are NOT touched, and keep their hashes);
//   * drops the pack's old UI seam transforms (kinds jsx, lazy, tap, expose, app-host) and derives them again from the stock source, as
//     atomic groups appended after every other transform; a group that does not derive is dropped and listed, and the pack ships degraded;
//   * rewrites `seams.hooks` from the transforms that applied (the host seams under `seams` are kept as they are).
// `--stock` defaults to the locator of stock.mjs (CODEXMODS_STOCK_ASAR, .tmp/asar-<bundle>/, the installed app) for the pack's build.
// The pack's protocol, binary patches, anchors and overrides are never read or changed here: a new BUILD needs builder/refresh-adapter.mjs.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyAll } from './transform.mjs';
import { applyUiSeams, isUiSeam } from './seams.mjs';
import { locateStock } from './stock.mjs';

/**
 * @param {object} pack an adapter pack
 * @param {{ list, read, size }} source the stock app's code, of the pack's build
 * @returns {{ pack: object, report: { applied: string[], dropped: object[], missing: object[], removed: string[], added: string[], declared: object|null, exposures: string[] } }}
 */
export function reseamPack(pack, source) {
  const kept = pack.transforms.filter((t) => !isUiSeam(t));
  // the pack's own transforms must apply to this source exactly as sealed: otherwise it is another build and nothing is changed
  applyAll(kept, (p) => source.read(p));
  const ui = applyUiSeams(source, kept);
  const transforms = ui.transforms;
  const hooks = ui.hooks;
  const { hooks: _old, ...hostSeams } = pack.seams ?? {};
  const seams = { ...hostSeams, ...(hooks ? { hooks } : {}) };
  const out = { ...pack, transforms };
  if (Object.keys(seams).length) out.seams = seams; else delete out.seams;
  const before = new Set(pack.transforms.filter(isUiSeam).map((t) => t.id)); const after = new Set(transforms.filter(isUiSeam).map((t) => t.id));
  return { pack: out, report: {
    applied: ui.applied, dropped: ui.dropped, missing: ui.missing,
    removed: [...before].filter((id) => !after.has(id)), added: [...after].filter((id) => !before.has(id)), declared: hooks,
    exposures: ui.exposures.map((e) => `${e.key}@${e.role}`),
  } };
}

export function main(argv, { log = console.log, error = console.error } = {}) {
  const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const packPath = opt('pack');
  if (!packPath) { error('usage: reseam-adapter.mjs --pack <adapter.json> [--stock <app.asar | dir>] [--out <adapter.json>] [--report <file>]'); return 2; }
  const pack = JSON.parse(readFileSync(packPath, 'utf8'));
  const stock = locateStock({ bundleVersion: pack.build.bundleVersion, version: pack.build.version, ...(opt('stock') ? { env: { CODEXMODS_STOCK_ASAR: opt('stock') }, installed: null } : {}) });
  if (!stock) { error(`no stock source for ${pack.build.version} (${pack.build.bundleVersion}): pass --stock or set CODEXMODS_STOCK_ASAR`); return 1; }
  try {
    const r = reseamPack(pack, stock.source);
    writeFileSync(opt('out') ?? packPath, JSON.stringify(r.pack, null, 2) + '\n');
    if (opt('report')) writeFileSync(opt('report'), JSON.stringify(r.report, null, 2) + '\n');
    log(`${opt('out') ?? packPath}: UI seam groups applied: ${r.report.applied.join(', ') || 'none'}; exposures: ${r.report.exposures.length}; missing: ${r.report.missing.length}`);
    for (const m of r.report.missing) log(`  missing ${m.item}: ${m.tried}`);
    return 0;
  } catch (e) { error(`${e.message}`); return 1; } finally { stock.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
