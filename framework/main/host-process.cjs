'use strict';
// Spawns the Host as a child of framework-main on the app's bundled Node (ARCHITECTURE change log v1.2).
// Channel: Node IPC, JSON serialization (stdio[3]); stdout/stderr go to a log file. Returns a normalized handle that
// index.cjs and its tests share: {postMessage, onMessage, onExit, kill}.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function spawnHostProcess({ nodePath, entry, logFile, env, spawnFn = spawn }) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(logFile, 'a', 0o600);
  let child;
  try {
    child = spawnFn(nodePath, [entry], { stdio: ['ignore', fd, fd, 'ipc'], serialization: 'json', env });
  } finally { fs.closeSync(fd); }
  const exitFns = [];
  let exited = false;
  const fireExit = (code, signal) => { if (exited) return; exited = true; for (const fn of exitFns) fn(code, signal); };
  child.on('exit', (code, signal) => fireExit(code, signal));
  child.on('error', () => fireExit(null, 'spawn-error'));
  return {
    postMessage: (msg) => { if (!exited && child.connected) child.send(msg); },
    onMessage: (fn) => child.on('message', fn),
    onExit: (fn) => { if (exited) fn(null, null); else exitFns.push(fn); },
    kill: () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } },
  };
}

module.exports = { spawnHostProcess };
