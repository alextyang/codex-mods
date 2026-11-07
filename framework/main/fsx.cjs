'use strict';
// Small synchronous fs helpers for framework-main (counterpart of framework/host/fsutil.mjs): atomic JSON writes at mode 0600.
const fs = require('node:fs');
const path = require('node:path');

function writeJsonSync(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } throw e; }
}
function readJsonSync(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** framework-main's own log: JSONL in layout.logs/main.log, one rotation at 5 MB. Never throws. */
function createMainLog(file) {
  const MAX = 5 * 1024 * 1024;
  const write = (level, msg, data) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      try { if (fs.statSync(file).size > MAX) fs.renameSync(file, `${file}.1`); } catch { /* no file yet */ }
      const rec = { t: new Date().toISOString(), level, scope: 'main', msg };
      if (data !== undefined) rec.data = data;
      fs.appendFileSync(file, JSON.stringify(rec) + '\n', { mode: 0o600 });
    } catch { /* logging must never break startup */ }
  };
  return { info: (m, d) => write('info', m, d), error: (m, d) => write('error', m, d), warn: (m, d) => write('warn', m, d) };
}

module.exports = { writeJsonSync, readJsonSync, createMainLog };
