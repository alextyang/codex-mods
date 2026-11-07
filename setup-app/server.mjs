#!/usr/bin/env node
// The setup app's page and what it asks of this Mac (setup-app/README.md): a server on 127.0.0.1 only, for the window the app opens on it.
// Its page is static; every API call needs this run's token (in the page's address after #, sent as a header, so no other page can make
// one) and must name this server as its host and origin. One job (setting up or uninstalling) runs at a time; the page reads its steps.
//
//   node setup-app/server.mjs [--parent <pid>]
//
// It prints `READY <url>` once it listens (on its own output only: the token never goes on a command line, where other users could read
// it). With --parent it ends when that process does. Node built-ins and the framework's own modules only.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSteps } from './steps.mjs';

const UI = join(dirname(fileURLToPath(import.meta.url)), 'ui');
const FILES = { '/': ['index.html', 'text/html; charset=utf-8'], '/setup.css': ['setup.css', 'text/css; charset=utf-8'], '/setup.js': ['setup.js', 'text/javascript; charset=utf-8'] };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** The server, not yet listening. `steps`: what it runs (createSteps by default); `token`: this run's. */
export function createSetupServer({ steps = createSteps(), token = randomBytes(24).toString('hex') } = {}) {
  let job = null;   // { kind, steps: [{ id, status, detail }], done, error, result }
  let port = 0;
  const same = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

  const startJob = (kind, fn) => {
    if (job && !job.done) throw Object.assign(new Error('Something is already running.'), { status: 409 });
    const j = { kind, steps: [], done: false, error: null, result: null };
    const onStep = (id, status, detail) => {
      const s = j.steps.find((x) => x.id === id);
      if (s) Object.assign(s, { status, ...(detail !== undefined ? { detail } : {}) }); else j.steps.push({ id, status, ...(detail !== undefined ? { detail } : {}) });
    };
    job = j;
    Promise.resolve().then(() => fn(onStep)).then((r) => { j.result = r ?? null; }, (e) => { j.error = String(e?.message ?? e); }).finally(() => { j.done = true; });
    return j;
  };

  const body = (req) => new Promise((res, rej) => {
    let n = 0; const parts = [];
    req.on('data', (c) => { n += c.length; if (n > 64 * 1024) { rej(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { res(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch { rej(Object.assign(new Error('not JSON'), { status: 400 })); } });
    req.on('error', rej);
  });

  const api = {
    'GET /api/check': () => steps.check(),
    'GET /api/job': () => job,
    'POST /api/install': async (req) => {
      const b = await body(req);
      const c = b?.choice ?? {};
      const choice = { mode: c.mode === 'daily' ? 'daily' : 'try', identity: typeof c.identity === 'string' ? c.identity.slice(0, 200) : '-', backup: c.backup === true, autoUpdate: typeof c.autoUpdate === 'boolean' ? c.autoUpdate : null, dock: c.dock === true };
      return startJob('install', (onStep) => steps.install(choice, onStep));
    },
    'POST /api/uninstall': () => startJob('uninstall', (onStep) => steps.uninstall(onStep)),
    'POST /api/open': async () => { await steps.open(); return { ok: true }; },
    'POST /api/reveal': async (req) => { const b = await body(req); await steps.reveal(String(b?.path ?? '')); return { ok: true }; },
  };

  const server = createServer(async (req, res) => {
    const send = (status, type, data, extra = {}) => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': CSP, ...extra }); res.end(data); };
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const host = `127.0.0.1:${port}`;
      // only this server, by its own name: a page elsewhere that points a name at 127.0.0.1 is not it
      if (req.headers.host !== host) return send(421, 'text/plain', 'wrong host');
      if (req.method === 'GET' && FILES[url.pathname]) {
        const [file, type] = FILES[url.pathname];
        return send(200, type, await readFile(join(UI, file)));
      }
      const fn = api[`${req.method} ${url.pathname}`];
      if (!fn) return send(404, 'text/plain', 'not found');
      if (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`) return send(403, 'text/plain', 'wrong origin');
      if (!same(req.headers['x-setup-token'], token)) return send(403, 'text/plain', 'no token');
      const out = await fn(req);
      return send(200, 'application/json', JSON.stringify(out ?? null));
    } catch (e) {
      return send(e?.status ?? 500, 'application/json', JSON.stringify({ error: String(e?.message ?? e) }));
    }
  });

  return {
    server, token,
    /** Listens on 127.0.0.1; answers the page's address with this run's token. */
    async listen(p = 0) {
      await new Promise((res, rej) => { server.once('error', rej); server.listen(p, '127.0.0.1', res); });
      port = server.address().port;
      return `http://127.0.0.1:${port}/#${token}`;
    },
    close: () => new Promise((res) => server.close(() => res())),
  };
}

async function main(argv) {
  const at = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const s = createSetupServer();
  const url = await s.listen();
  process.stdout.write(`READY ${url}\n`);
  const parent = Number(at('--parent'));
  if (Number.isSafeInteger(parent) && parent > 1) {
    setInterval(() => { try { process.kill(parent, 0); } catch { process.exit(0); } }, 2000).unref?.();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e) => { process.stderr.write(`${e?.message ?? e}\n`); process.exitCode = 1; });
}
