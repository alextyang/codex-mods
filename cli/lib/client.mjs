// JSONL client for the Host's management socket (contracts/management.d.ts).
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { CodexModsError } from '../../sdk/errors.mjs';

export class HostNotRunning extends Error {
  constructor(detail) { super(`Host not running${detail ? ` (${detail})` : ''}`); this.name = 'HostNotRunning'; }
}

/** Connect to mgmt.sock with the token from mgmt.token. Rejects HostNotRunning when either is missing or refused. */
export async function connectHost(ctx) {
  let token;
  try { token = (await readFile(ctx.tokenPath, 'utf8')).trim(); } catch (e) {
    if (e.code === 'ENOENT') throw new HostNotRunning('no management token');
    throw e;
  }
  const socket = await new Promise((resolve, reject) => {
    const s = net.connect(ctx.socketPath);
    s.once('connect', () => { s.off('error', reject); resolve(s); });
    s.once('error', reject);
  }).catch((e) => {
    if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED' || e.code === 'ENOTSOCK') throw new HostNotRunning(e.code);
    throw e;
  });
  return makeClient(socket, token);
}

export function makeClient(socket, token) {
  socket.setEncoding('utf8');
  let nextId = 1;
  let sentToken = false;
  let buffer = '';
  let closedError = null;
  const pending = new Map();
  const listeners = new Set();
  const onClose = new Set();

  socket.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg && typeof msg === 'object' && typeof msg.event === 'string' && msg.id === undefined) {
        for (const fn of [...listeners]) fn(msg);
      } else if (msg && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(CodexModsError.fromJSON(msg.error));
      } else if (msg && msg.ok === false && msg.id === null && pending.size > 0) {
        // Connection-level refusal (for example Denied for a bad token): fail everything waiting.
        const e = CodexModsError.fromJSON(msg.error);
        for (const p of pending.values()) p.reject(e);
        pending.clear();
      }
    }
  });
  const finish = () => {
    closedError ??= new CodexModsError('Unavailable', 'Host connection closed');
    for (const p of pending.values()) p.reject(closedError);
    pending.clear();
    for (const fn of [...onClose]) fn();
  };
  socket.on('close', finish);
  socket.on('error', () => {});

  return {
    call(method, params) {
      if (closedError || socket.destroyed) return Promise.reject(closedError ?? new CodexModsError('Unavailable', 'Host connection closed'));
      const id = nextId++;
      const req = { id, method, ...(params === undefined ? {} : { params }), ...(sentToken ? {} : { token }) };
      sentToken = true;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.write(`${JSON.stringify(req)}\n`);
      });
    },
    onEvent(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
    onClose(fn) { onClose.add(fn); return { dispose: () => onClose.delete(fn) }; },
    close() { socket.destroy(); },
  };
}

/**
 * Follow an operation until it ends. The subscription is established before the first read, so no event is missed.
 * onProgress(op) is called for each changed record (phases).
 */
/** `until(op)`: done before the op ends (an update's switch, after which the app quits). */
export async function waitForOp(client, opId, { onProgress, until } = {}) {
  let done;
  let seen = '';
  const finished = new Promise((resolve, reject) => { done = { resolve, reject }; });
  const check = (op) => {
    if (op.id !== opId) return;
    const sig = `${op.outcome}|${op.phases.length}`;
    if (sig !== seen) { seen = sig; onProgress?.(op); }
    if (op.outcome !== 'running' || until?.(op)) done.resolve(op);
  };
  const sub = client.onEvent((e) => { if (e.event === 'op') check(e.data); });
  const closeSub = client.onClose(() => done.reject(new CodexModsError('Unavailable', `Host connection closed while waiting for ${opId}; it may still be running: codexmods ops wait ${opId}`)));
  try {
    await client.call('events.subscribe', {});
    check(await client.call('ops.get', { opId }));
    return await finished;
  } finally { sub.dispose(); closeSub.dispose(); }
}
