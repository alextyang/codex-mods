// Host log (contracts/host.d.ts Log). JSONL, one file, rotated at 5 MB keeping one previous file.
// Callers pass metadata only: never message payloads, secrets or tokens (contracts/README.md convention 7).
import { appendFileSync, mkdirSync, statSync, renameSync, chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
export const MAX_LOG_BYTES = 5 * 1024 * 1024;

/**
 * @param {{ file: string, level?: 'debug'|'info'|'warn'|'error', maxBytes?: number }} opts
 * @returns {import('../../contracts/host.d.ts').Log & { close(): void }}
 */
export function createLog({ file, level = 'info', maxBytes = MAX_LOG_BYTES }) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  let size = 0, closed = false, ready = false;

  function open() {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try { size = statSync(file).size; } catch { size = 0; }
    ready = true;
  }
  function write(line) {
    if (closed) return;
    try {
      if (!ready) open();
      const bytes = Buffer.byteLength(line);
      if (size > 0 && size + bytes > maxBytes) {
        renameSync(file, `${file}.1`);   // replaces any previous rotation: exactly one previous file is kept
        size = 0;
      }
      const fresh = !existsSync(file);
      appendFileSync(file, line, { mode: 0o600 });
      if (fresh) chmodSync(file, 0o600);
      size += bytes;
    } catch { /* logging must never take the Host down */ }
  }
  function make(scope) {
    const at = (lvl) => (msg, data) => {
      if (LEVELS[lvl] < threshold) return;
      const rec = { t: new Date().toISOString(), level: lvl, scope, msg };
      if (data !== undefined) rec.data = data;
      let line;
      try { line = JSON.stringify(rec) + '\n'; } catch { line = JSON.stringify({ ...rec, data: '[unserializable]' }) + '\n'; }
      write(line);
    };
    return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'),
      child: (s) => make(scope ? `${scope}/${s}` : s) };
  }
  return { ...make('host'), close() { closed = true; } };
}
