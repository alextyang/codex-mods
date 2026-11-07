// A line client for the fake app-server (fake-app-server.mjs), for its own tests and those of its area modules (fake-areas/): spawn one,
// talk to it, and check what it sends against the protocol's schema of every build since 20770. Node built-ins only.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildsSince } from './captures.mjs';
import { frameIssues } from './schema-check.mjs';

export const FAKE = fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url));

/** A fake process and a line client: request(method, params) → the reply; notify; inbox (what the fake sent unasked); stderr. */
export function startFake(o = {}) {
  const p = spawn(process.execPath, [FAKE, 'app-server', '--name', o.name ?? 'primary'], { env: { ...process.env, ...(o.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  const inbox = [];
  let buf = '', err = '', seq = 0, exited = false;
  p.once('exit', () => { exited = true; });
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.method === undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } else inbox.push(m);
    }
  });
  p.stderr.setEncoding('utf8');
  p.stderr.on('data', (d) => { err += d; });
  const write = (m) => p.stdin.write(JSON.stringify(m) + '\n');
  return {
    request: (method, params) => new Promise((r) => { const id = ++seq; waiting.set(id, r); write({ id, method, ...(params === undefined ? {} : { params }) }); }),
    notify: (method, params) => write({ method, ...(params === undefined ? {} : { params }) }),
    answer: (id, result) => write({ id, result }),
    inbox,
    stderr: () => err,
    async until(pred, ms = 3000) { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } },
    close: () => new Promise((r) => { if (exited) return r(); p.once('exit', r); p.kill(); return undefined; }),
  };
}

/** The builds a modelled payload is held to (the newest one is the fake's own protocol). */
export const BUILDS = buildsSince('26.1013.40934-20770');
/** Every way a payload breaks the schema of a build since 20770, as readable lines (none: it matches). */
export const shapeIssues = (part, method, v) => BUILDS.flatMap((b) => frameIssues(b, part, method, v).map((i) => `${b} ${part} ${method}: ${i.path} ${i.message}`));
/** A started fake, initialized. */
export async function startInitialized(o = {}) {
  const f = startFake(o);
  await f.request('initialize', { clientInfo: { name: 't', title: null, version: '1' } });
  f.notify('initialized');
  return f;
}
