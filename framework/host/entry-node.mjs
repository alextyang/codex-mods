// Host entry (contracts/host.d.ts HostStartOptions; ARCHITECTURE change log v1.2). Runs on the app's bundled Node, either
//   - as a child of framework-main with a Node IPC channel (stdio 'ipc', JSON serialization): the first message is
//     {type:'init', options}; every later message is MainToHost, and the Host posts HostToMain back; or
//   - as a plain Node process for headless tests: usage `node entry-node.mjs '<HostStartOptions JSON>'` with no parent.
// Headless mode prints one JSON line {"type":"ready"} on stdout when the Host is up.
// Shuts down on SIGTERM/SIGINT, on IPC disconnect (framework-main is gone), on a {type:'shutdown'} message, and, when
// CODEXMODS_EXIT_ON_STDIN_EOF=1, on stdin EOF (so a test harness cannot leak a Host).
// Test-only: CODEXMODS_TEST_FACTORIES=<path of a module whose default export is a factories override> (see main.mjs).
import { pathToFileURL, fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { startHost } from './main.mjs';

/** Adapt the Node IPC channel to a RealmPort with buffering: messages that arrive before startHost subscribes are kept in order. */
export function createIpcParent(proc, { onShutdown } = {}) {
  const buffer = [], listeners = new Set();
  let resolveInit;
  const init = new Promise((r) => { resolveInit = r; });
  proc.on('message', (msg) => {
    if (msg?.type === 'init') return resolveInit(msg.options);
    if (msg?.type === 'shutdown') onShutdown?.();
    if (listeners.size === 0) buffer.push(msg); else for (const l of [...listeners]) l(msg);
  });
  const port = {
    post: (m) => { if (proc.connected !== false) proc.send(m); },
    onMessage(fn) {
      listeners.add(fn);
      for (const m of buffer.splice(0)) fn(m);
      return { dispose: () => listeners.delete(fn) };
    },
    onClose(fn) { proc.on('disconnect', fn); return { dispose: () => proc.off('disconnect', fn) }; },
  };
  return { port, init };
}

async function loadFactories() {
  const f = process.env.CODEXMODS_TEST_FACTORIES;
  return f ? (await import(pathToFileURL(isAbsolute(f) ? f : resolve(f)).href)).default : undefined;
}

async function run() {
  const ipc = typeof process.send === 'function';
  let started = null, stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    (started ?? Promise.resolve(null)).then((h) => h?.close()).then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);

  let options, parent;
  if (ipc) {
    const p = createIpcParent(process, { onShutdown: stop });
    parent = p.port;
    process.on('disconnect', stop);
    options = await p.init;
  } else {
    try { options = JSON.parse(process.argv[2] ?? ''); } catch { throw new Error('usage: entry-node.mjs <HostStartOptions JSON>'); }
    delete options.parent;
    if (process.env.CODEXMODS_EXIT_ON_STDIN_EOF === '1') { process.stdin.on('end', stop); process.stdin.on('close', stop); process.stdin.resume(); }
  }
  const factories = await loadFactories();
  started = startHost({ ...options, ...(parent ? { parent } : {}), ...(factories ? { factories } : {}) });
  await started;
  if (!ipc) process.stdout.write(JSON.stringify({ type: 'ready' }) + '\n');
}

const isMain = (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  run().catch((e) => {
    process.stderr.write(`host failed to start: ${e?.stack ?? e}\n`);
    process.exit(1);
  });
}
