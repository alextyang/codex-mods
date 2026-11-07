// The framework's internal mods (reference-mods.md §0 and §2; graph-boundary.md D7): functionality the app does not have, which the
// framework ships in framework/mods/<id>/, runs as mods of its own (a worker, a ctx, the same grants checks) and integrates with. Each is
// started by the Host itself before the user's mods, granted what its manifest asks (it is the framework's own code, so consent is not
// asked), never listed among the user's mods, never installed, updated, replaced or removed as a package (its id is reserved), and not run
// in safe mode. What only an internal mod gets from the Host: a `hiddenRoot` for its app-server client (its threads are private: the
// mux's private threads).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest } from './packages/manifest.mjs';
import { INTERNAL_MOD_IDS } from '../shared/internal-mods.mjs';

/** The internal mods' ids: reserved, so no package may take one. */
export { INTERNAL_MOD_IDS };
export const INTERNAL_DIR = fileURLToPath(new URL('../mods/', import.meta.url));

/** The folder under which an internal mod's private threads start (its data folder's `threads`). */
export const hiddenRootOf = (dataDir) => join(dataDir, 'threads');

/**
 * The internal mods as the runtime activates them (InstalledMod views, `internal: true`), from `dir` (the shipped framework/mods by default).
 * A folder that is not one of INTERNAL_MOD_IDS, or whose manifest is invalid, is skipped with a warning.
 */
export function internalMods({ layout, dir = INTERNAL_DIR, log = null, now = () => new Date().toISOString() }) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const id of readdirSync(dir).sort()) {
    if (!INTERNAL_MOD_IDS.includes(id)) continue;
    const packageDir = join(dir, id);
    let manifest;
    try { manifest = validateManifest(JSON.parse(readFileSync(join(packageDir, 'mod.json'), 'utf8')), { internal: true }); } catch (e) {
      log?.warn?.('an internal mod could not be read', { id, message: String(e?.message ?? e) });
      continue;
    }
    if (manifest.id !== id) { log?.warn?.('an internal mod\'s id is not its folder\'s', { id, manifestId: manifest.id }); continue; }
    const t = now();
    out.push({
      record: { id, version: manifest.version, status: 'enabled', publisher: null, grants: [...(manifest.permissions ?? [])], dataSchemaVersion: 0,
        installedAt: t, updatedAt: t, installSeq: 0, internal: true },
      manifest, packageDir, internal: true,
      dataDir: join(layout.data, id), retainedDir: join(layout.retained, id), backendsDir: join(layout.backends, id),
    });
  }
  return out;
}
