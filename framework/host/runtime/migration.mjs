// Runtime.runMigration: run the migration script in a separate Worker (see migration-worker.mjs for the isolation statement).
import { Worker } from 'node:worker_threads';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CodexModsError } from '../../../sdk/errors.mjs';
import { hostDeadline } from '../deadline.mjs';

export const MIGRATION_LIMITS = Object.freeze({ maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 });

export function runMigration({ mod, script, stagedDataDir, from, to, timeoutMs }) {
  return new Promise((resolvePromise, reject) => {
    if (typeof script !== 'string' || !script) return reject(new CodexModsError('Invalid', 'migration script is required'));
    const abs = isAbsolute(script) ? script : resolve(mod.packageDir, script);
    const rel = relative(mod.packageDir, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) return reject(new CodexModsError('Invalid', 'migration script is outside the package'));
    let settled = false;
    const worker = new Worker(new URL('./migration-worker.mjs', import.meta.url), {
      workerData: { script: pathToFileURL(abs).href, stagedDataDir, from, to, schema: mod.manifest.settings },
      resourceLimits: MIGRATION_LIMITS,
      stdout: false, stderr: false,
    });
    const finish = (fn) => { if (settled) return; settled = true; deadline.stop(); fn(); worker.terminate().catch(() => {}); };
    const deadline = hostDeadline(timeoutMs, () => finish(() => reject(new CodexModsError('Timeout', `the migration did not finish within ${timeoutMs} ms`))), { unref: false });
    worker.on('message', (m) => {
      if (m?.t === 'done') finish(resolvePromise);
      else if (m?.t === 'error') finish(() => reject(new CodexModsError('Invalid', `the migration failed: ${m.message}`)));
    });
    worker.on('error', (e) => finish(() => reject(new CodexModsError('Invalid', `the migration crashed: ${e?.code ?? e?.message ?? e}`))));
    worker.on('exit', (code) => finish(() => reject(new CodexModsError('Invalid', `the migration worker exited (${code}) before finishing`))));
  });
}
