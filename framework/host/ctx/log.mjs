// ctx.log → layout.logs/<modId>.log (JSONL), 1 MB rotation to <modId>.log.1, per-mod ring buffer, rate limit.
// Logs hold whatever the mod chooses to log; the framework itself adds metadata only.
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const MAX_MESSAGE = 4096;
const MAX_DATA = 8192;

export function createModLogger({ file, maxBytes = 1_000_000, ringSize = 200, ratePerSecond = 200, clock = Date.now, onWrite }) {
  const ring = [];
  let size = null;
  let chain = Promise.resolve();
  let windowStart = 0, windowCount = 0, dropped = 0;

  const append = (line) => {
    chain = chain.then(async () => {
      if (size === null) {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        size = await stat(file).then((s) => s.size, () => 0);
      }
      const len = Buffer.byteLength(line);
      if (size > 0 && size + len > maxBytes) { await rename(file, `${file}.1`); size = 0; }
      await appendFile(file, line, { mode: 0o600 });
      size += len;
    }).catch(() => {});
  };

  function record(level, message, data, realm) {
    let msg = String(message);
    if (msg.length > MAX_MESSAGE) msg = `${msg.slice(0, MAX_MESSAGE)}…`;
    const entry = { ts: new Date(clock()).toISOString(), level, realm, msg };
    if (data !== undefined && data !== null) {
      let text; try { text = JSON.stringify(data); } catch { text = '"[unserializable]"'; }
      entry.data = text.length > MAX_DATA ? `${text.slice(0, MAX_DATA)}…[truncated]` : JSON.parse(text);
    }
    ring.push(entry);
    if (ring.length > ringSize) ring.shift();
    append(`${JSON.stringify(entry)}\n`);
    try { onWrite?.(); } catch { /* the listener's own */ }
  }

  return {
    write(level, message, data, realm = 'host') {
      if (!LEVELS.has(level)) return;
      const t = clock();
      if (t - windowStart >= 1000) {
        if (dropped > 0) { record('warn', `log rate limit: ${dropped} line(s) dropped`, undefined, 'framework'); dropped = 0; }
        windowStart = t; windowCount = 0;
      }
      if (++windowCount > ratePerSecond) { dropped++; return; }
      record(level, message, data, realm);
    },
    recent: () => ring.slice(),
    flush: () => { if (dropped > 0) { record('warn', `log rate limit: ${dropped} line(s) dropped`, undefined, 'framework'); dropped = 0; } return chain; },
  };
}

export function createLogNs() {
  return {
    calls: {
      write(scope, level, message, data) { scope.state.logger.write(level, message, data, scope.realm); },
    },
  };
}
