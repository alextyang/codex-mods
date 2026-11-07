// Orphaned data of keep-data removals, kept as generations (contracts v1.13):
//   orphaned/<modId>/<ISO-timestamp>/   the data directory as it was, plus `.orphan.json` {publisher, version, dataSchemaVersion, removedAt}
// A keep-data removal always adds a generation and never overwrites or deletes an earlier one; only a delete-data removal clears them all.
import { readdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const ORPHAN_META = '.orphan.json';
const ISO_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z(-\d+)?$/;

export function createOrphans(L) {
  const dirOf = (id) => join(L.orphaned, id);
  const genDir = (id, at) => join(dirOf(id), at);

  const readMeta = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
  const writeMeta = (path, value) => {
    const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, path);
  };
  const names = (path) => { try { return readdirSync(path); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };
  /**
   * A generation is an ISO-named directory carrying an `.orphan.json` that records `removedAt`. A timestamp-shaped name alone proves
   * nothing.
   */
  const isGeneration = (id, name) => {
    if (!ISO_NAME.test(name)) return false;
    const m = readMeta(join(genDir(id, name), ORPHAN_META));
    return Boolean(m) && typeof m === 'object' && typeof m.removedAt === 'string';
  };

  return {
    ORPHAN_META, dirOf, genDir,
    /** A fresh generation name (ISO timestamp) that does not exist yet. */
    uniqueAt(id) {
      let t = Date.now();
      for (;;) { const at = new Date(t).toISOString(); if (!existsSync(genDir(id, at))) return at; t++; }
    },
    /** Generations of a mod, newest first: [{at, version, dataSchemaVersion, publisher, dir, meta}]. */
    list(id) {
      return names(dirOf(id)).filter((n) => isGeneration(id, n)).sort().reverse().map((at) => {
        const meta = readMeta(join(genDir(id, at), ORPHAN_META)) ?? {};
        return { at, version: meta.version ?? null, dataSchemaVersion: meta.dataSchemaVersion ?? 0, publisher: meta.publisher ?? null, meta, dir: genDir(id, at) };
      });
    },
    writeMeta: (id, at, value) => writeMeta(join(genDir(id, at), ORPHAN_META), value),
    hasMeta: (id, at) => existsSync(join(genDir(id, at), ORPHAN_META)),
    /** Remove the (now empty) mod directory when its last generation is gone. */
    pruneEmpty(id) { try { if (names(dirOf(id)).length === 0) rmSync(dirOf(id), { recursive: true, force: true }); } catch { /* best effort */ } },
  };
}
