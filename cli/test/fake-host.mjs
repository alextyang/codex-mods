// An in-process fake Management socket (independent of createManagement) plus an io harness for CLI tests.
import net from 'node:net';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { layout, SOCKETS } from '../../contracts/layout.mjs';

export async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'cl-'));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** handlers: method → (params, conn) => result | Promise; throw {code,message} for errors. */
export async function startFakeHost(root, handlers, { profile = 'default', token = 'a'.repeat(64) } = {}) {
  const lay = layout(root, profile);
  await mkdir(lay.run, { recursive: true, mode: 0o700 });
  await writeFile(join(lay.run, 'mgmt.token'), `${token}\n`, { mode: 0o600 });
  const calls = [];
  const conns = new Set();
  const subscribers = new Set();
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    const conn = { socket, authed: false, subscribed: false };
    conns.add(conn);
    let buf = '';
    socket.on('data', async (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const req = JSON.parse(line);
        if (!conn.authed) {
          if (req.token !== token) { socket.write(`${JSON.stringify({ id: req.id, ok: false, error: { code: 'Denied', message: 'bad token' } })}\n`); socket.end(); return; }
          conn.authed = true;
        }
        calls.push({ method: req.method, params: req.params });
        try {
          let result;
          if (req.method === 'events.subscribe') { conn.subscribed = true; subscribers.add(conn); result = { subscribed: true }; }
          else result = await handlers[req.method]?.(req.params ?? {}, conn);
          if (result === undefined && !handlers[req.method] && req.method !== 'events.subscribe') throw { code: 'Invalid', message: `Unknown method "${req.method}"` };
          socket.write(`${JSON.stringify({ id: req.id, ok: true, result })}\n`);
        } catch (e) {
          socket.write(`${JSON.stringify({ id: req.id, ok: false, error: { code: e.code ?? 'Unavailable', message: e.message ?? String(e) } })}\n`);
        }
      }
    });
    socket.on('close', () => { conns.delete(conn); subscribers.delete(conn); });
    socket.on('error', () => {});
  });
  await new Promise((r) => server.listen(join(lay.run, SOCKETS.management), r));
  return {
    layout: lay, calls,
    emit(event) { for (const c of subscribers) c.socket.write(`${JSON.stringify(event)}\n`); },
    get subscriberCount() { return subscribers.size; },
    async close() { for (const c of conns) c.socket.destroy(); await new Promise((r) => server.close(r)); },
  };
}

export function makeIo(root, extra = {}) {
  const stdout = []; const stderr = [];
  const io = {
    stdout: { write: (s) => stdout.push(s) }, stderr: { write: (s) => stderr.push(s) },
    env: { CODEX_MODS_ROOT: root }, cwd: '/work/dir', ...extra,
  };
  Object.defineProperty(io, 'out', { get: () => stdout.join('') });
  Object.defineProperty(io, 'err', { get: () => stderr.join('') });
  return io;
}

export const op = (over = {}) => ({
  id: 'op-0000000000000001', input: { type: 'enable', modId: 'acme.demo' }, outcome: 'running', phases: [],
  startedAt: '2026-10-11T00:00:00.000Z', ...over,
});
