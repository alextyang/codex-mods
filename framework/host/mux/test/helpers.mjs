// Test harness for the mux: fake Bus, a PassThrough-pair "app", a scripted child-process factory and the fake app-server launcher.
import { PassThrough, Duplex } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { createMux } from '../index.mjs';
import { createTestLog } from '../../../../tests/fixtures/log.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const FAKE = join(here, '../../../../tests/fixtures/fake-app-server.mjs');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, ms = 15000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

export const catalog = {
  handshake: { request: 'initialize', notification: 'initialized' },
  affinityKeyPaths: ['params.threadId', 'params.thread.id'],
  affinityCreators: [
    { method: 'thread/start', resultPath: 'thread.id' },
    { method: 'thread/resume', resultPath: 'thread.id' },
    { method: 'thread/fork', resultPath: 'thread.id' },
  ],
  methods: { clientRequests: [], clientNotifications: [], serverRequests: [], serverNotifications: [] },
};

export function makeBus() {
  const events = [], subs = [], states = new Map();
  return {
    events,
    publish(topic, data, o) { events.push({ topic, data }); if (o?.state) states.set(topic, data); for (const s of subs) if (s.re.test(topic)) s.fn(data, topic); },
    subscribe(pattern, fn) { const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'); const s = { re, fn }; subs.push(s); return { dispose() { subs.splice(subs.indexOf(s), 1); } }; },
    state: (t) => states.get(t),
    topics: () => events.map((e) => e.topic),
    count: (t) => events.filter((e) => e.topic === t).length,
  };
}

/** The app side of a connection, plus the Duplex to hand to mux.attachApp. */
export function makeApp() {
  const toMux = new PassThrough(), fromMux = new PassThrough();
  const stream = Duplex.from({ readable: toMux, writable: fromMux });
  for (const x of [stream, toMux, fromMux]) x.on('error', () => {});
  const inbox = [], waiters = [];
  let buf = '';
  fromMux.setEncoding('utf8');
  fromMux.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      inbox.push(m);
      for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
    }
  });
  const app = {
    stream, inbox,
    send: (o) => toMux.write(JSON.stringify(o) + '\n'),
    raw: (s) => toMux.write(s),
    waitFor(pred, ms = 15000) {
      const hit = inbox.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((res, rej) => {
        const w = { pred, res: (m) => { clearTimeout(t); res(m); } };
        const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('app: timed out waiting for a message')); }, ms);
        waiters.push(w);
      });
    },
    reply: (id, ms) => app.waitFor((m) => m.id === id && m.method === undefined, ms),
    async request(id, method, params, ms) { app.send(params === undefined ? { id, method } : { id, method, params }); return app.reply(id, ms); },
    async handshake(params = { clientInfo: { name: 'test-app', version: '0' } }) {
      const r = await app.request('init', 'initialize', params);
      app.send({ method: 'initialized' });
      return r;
    },
    end() { toMux.end(); },
    destroy() { toMux.destroy(); fromMux.destroy(); },
  };
  return app;
}

/** Scripted child-process factory (`spawn` option): full control over a backend's stdio. */
export function scriptedSpawn() {
  const procs = [];
  const spawn = (command, args, o) => {
    const p = new EventEmitter();
    Object.assign(p, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 4000 + procs.length, signals: [], written: [], command, args, env: o?.env, autoExitOn: ['SIGTERM'] });
    let buf = '';
    p.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line) p.written.push(JSON.parse(line)); } });
    p.kill = (sig) => { p.signals.push(sig); if (p.autoExitOn.includes(sig)) setImmediate(() => p.exit(null, sig)); return true; };
    p.exit = (code, sig = null) => { if (p.exited) return; p.exited = true; p.stdout.end(); p.emit('exit', code, sig); p.emit('close', code, sig); };
    p.out = (o) => p.stdout.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n');
    p.outMany = (list) => p.stdout.write(list.map((o) => JSON.stringify(o)).join('\n') + '\n');
    p.waitWritten = (pred, ms = 10000) => until(() => p.written.find(pred), ms, 'a frame written to the backend');
    procs.push(p);
    return p;
  };
  return { spawn, procs };
}

export function fakeLaunch(dir, extraEnv = {}) {
  return (id, def) => {
    const key = id === 'primary' ? 'primary' : id.slice(id.indexOf('/') + 1);
    return {
      command: process.execPath, args: [FAKE, 'app-server', '--name', key],
      env: { FAKE_APP_SERVER_LOG: join(dir, 'server.log'), ...(def?.env ?? {}), ...extraEnv },
      codexHome: def?.codexHome ?? join(dir, 'home-primary'),
    };
  };
}

export async function harness(o = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mux-'));
  const sock = join(dir, 'c.sock');
  const entries = [];
  const log = createTestLog('mux', entries);
  const bus = makeBus();
  const mux = createMux({
    catalog: o.catalog ?? catalog, launchFor: o.launchFor ?? fakeLaunch(dir), bus, log, clientsSocketPath: sock,
    beforePrimaryStart: o.beforePrimaryStart, spawn: o.spawn, tuning: o.tuning, primaryConfig: o.primaryConfig, journal: o.journal,
  });
  const app = makeApp();
  const h = {
    dir, sock, entries, log, bus, mux, app,
    serverLog: () => (existsSync(join(dir, 'server.log')) ? readFileSync(join(dir, 'server.log'), 'utf8').split('\n').filter(Boolean) : []),
    logged: (level, re) => entries.some((e) => e.level === level && re.test(e.msg)),
    attach() { mux.attachApp(app.stream); },
    async up() {
      h.attach(); await app.handshake();
      await until(() => bus.count('appServer/ready') >= 1, 12000, 'appServer/ready');
      // `initialized` is forwarded after the (earlier) ready; wait for it so later backends see it in their replay.
      await until(() => !existsSync(join(dir, 'server.log')) || h.serverLog().some((l) => l.includes('"method":"initialized"')), 12000, 'initialized forwarded');
    },
    async define(owner, key, def = {}) { await mux.defineBackend(owner, key, { codexHome: join(dir, 'home-' + key), ...def }); },
    async close() { app.destroy(); await mux.close(); await rm(dir, { recursive: true, force: true }); },
  };
  return h;
}

/** Connect to a clients socket, send the lease line, and return a line-oriented client. */
export async function leaseConnect(sock, lease, { firstLine } = {}) {
  const s = net.connect(sock);
  await new Promise((res, rej) => { s.once('connect', res); s.once('error', rej); });
  const inbox = [], waiters = [];
  let buf = '', closed = false;
  s.setEncoding('utf8');
  s.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line); inbox.push(m);
      for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
    }
  });
  const closedP = new Promise((res) => s.on('close', () => { closed = true; res(); }));
  s.on('error', () => {});
  const c = {
    s, inbox, closedP, get closed() { return closed; },
    send: (o) => s.write(JSON.stringify(o) + '\n'),
    waitFor(pred, ms = 15000) {
      const hit = inbox.find(pred); if (hit) return Promise.resolve(hit);
      return new Promise((res, rej) => { const w = { pred, res: (m) => { clearTimeout(t); res(m); } }; const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('lease: timed out')); }, ms); waiters.push(w); });
    },
    reply: (id, ms) => c.waitFor((m) => m.id === id && m.method === undefined, ms),
    async request(id, method, params) { c.send({ id, method, params }); return c.reply(id); },
    destroy: () => s.destroy(),
  };
  s.write(firstLine ?? JSON.stringify({ lease: lease.id, token: lease.token }) + '\n');
  return c;
}
