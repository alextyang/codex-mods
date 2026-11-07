// JSONL over a net.Socket as a RealmPort, plus the process-side connect helper for proc.sock (contracts/ipc.d.ts §4).
// Node-only (unlike framework/shared/realm-client.mjs).
import net from 'node:net';

const MAX_LINE = 16 * 1024 * 1024;

/** @param {net.Socket} socket @param {string} [initial] bytes already read from the socket after the handshake line */
export function socketPort(socket, initial = '') {
  const handlers = new Set();
  const closers = new Set();
  let buffer = '';
  let closed = false;
  const feed = (text) => {
    buffer += text;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      for (const fn of [...handlers]) { try { fn(msg); } catch { /* handler errors are the handler's */ } }
    }
    if (buffer.length > MAX_LINE) socket.destroy();
  };
  socket.setEncoding('utf8');
  socket.on('data', feed);
  const onClose = () => { if (closed) return; closed = true; for (const fn of [...closers]) { try { fn(); } catch { /* ignore */ } } };
  socket.on('close', onClose);
  socket.on('error', () => {});
  if (initial) queueMicrotask(() => feed(initial));
  return {
    post(message) { if (!closed && !socket.destroyed) socket.write(`${JSON.stringify(message)}\n`); },
    onMessage(fn) { handlers.add(fn); return { dispose: () => { handlers.delete(fn); } }; },
    onClose(fn) { closers.add(fn); if (closed) queueMicrotask(fn); return { dispose: () => { closers.delete(fn); } }; },
    close() { socket.destroy(); },
  };
}

/**
 * For a mod process: connect to the Host's proc.sock and authenticate. Defaults come from the environment the Host gives
 * every mod process (CODEX_MODS_PROC_SOCKET, CODEX_MODS_PROC_TOKEN, CODEX_MODS_MOD_ID, CODEX_MODS_PROCESS).
 * Resolves {port, modId} ready for createRealmClient(port); rejects if the Host refuses the handshake.
 */
export function connectProcessRealm({ socketPath, token, modId, process: name } = {}, env = process.env) {
  socketPath ??= env.CODEX_MODS_PROC_SOCKET; token ??= env.CODEX_MODS_PROC_TOKEN;
  modId ??= env.CODEX_MODS_MOD_ID; name ??= env.CODEX_MODS_PROCESS;
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buf = '';
    const fail = (e) => { socket.destroy(); reject(e); };
    socket.setEncoding('utf8');
    socket.once('error', fail);
    socket.once('connect', () => socket.write(`${JSON.stringify({ process: name, mod: modId, token })}\n`));
    const onData = (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      socket.off('data', onData); socket.off('error', fail);
      let reply; try { reply = JSON.parse(buf.slice(0, nl)); } catch { return fail(new Error('bad handshake reply')); }
      if (!reply?.ok) return fail(new Error('handshake refused'));
      resolve({ port: socketPort(socket, buf.slice(nl + 1)), modId });
    };
    socket.on('data', onData);
    socket.once('close', () => fail(new Error('connection closed during handshake')));
  });
}
