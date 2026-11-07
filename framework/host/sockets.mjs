// Unix-socket listener helper for the Host's app.sock (and anything else the Host serves).
import { createServer, connect } from 'node:net';
import { mkdirSync, chmodSync, unlinkSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { CodexModsError } from '../../sdk/errors.mjs';

/** macOS sun_path is 104 bytes including the terminator. */
export const MAX_SOCKET_PATH = 103;

/** Resolves true if something accepts connections on `path`. */
function isLive(path) {
  return new Promise((resolve) => {
    const c = connect(path);
    c.once('connect', () => { c.destroy(); resolve(true); });
    c.once('error', () => resolve(false));
  });
}

/**
 * Listen on a Unix socket (mode 0600, parent dir 0700). A stale socket file is replaced; a live one is a Conflict.
 * `onConnection` receives each accepted stream.
 * @returns {Promise<{ server: import('node:net').Server, close(): Promise<void> }>}
 */
export async function listenUnix(path, onConnection) {
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH) {
    throw new CodexModsError('Invalid', `Socket path too long (${Buffer.byteLength(path)} > ${MAX_SOCKET_PATH} bytes): ${path}`);
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let st = null;
  try { st = lstatSync(path); } catch { /* absent */ }
  if (st) {
    if (!st.isSocket()) throw new CodexModsError('Conflict', `Not a socket: ${path}`);
    if (await isLive(path)) throw new CodexModsError('Conflict', `Another Host is already listening on ${path}`);
    unlinkSync(path);
  }
  const server = createServer(onConnection);
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.once('close', () => sockets.delete(s)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  chmodSync(path, 0o600);
  let closing = null;
  return {
    server,
    close() {
      closing ??= new Promise((resolve) => {
        server.close(() => resolve());
        for (const s of sockets) s.destroy();
      });
      return closing;
    },
  };
}
