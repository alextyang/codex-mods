#!/usr/bin/env node
// QA-only app-server client through a mux connection lease (gate G-protocol; test builds only). Run AS UID503 next to a running QA copy:
//   node scripts/qa/lease.mjs <lease.json> '<json array of {method, params}>' [--watch <seconds>] [--full] [--answer '<json result>']
// The lease descriptor ({id, socketPath, token}) is written by a mod holding `appServer.clients` (codexmods.live-usage writes
// <dataDir>/files/lease.json). Sends initialize with experimentalApi, then each request in order, waiting for its reply; then watches
// notifications for --watch seconds (default 3). Prints one JSON summary: replies (truncated unless --full), and notifications by method
// with the first few. A params string "${<n>.<path>}" is replaced by that path of request n's result (0-based), so one connection can
// start a thread and use its id; {"method": "$sleep", "params": {"ms": n}} waits between requests. With --answer, every server request is answered with that result (for example {"decision":"decline"}).
import fs from 'node:fs';
import net from 'node:net';

const [leaseFile, requestsJson, ...rest] = process.argv.slice(2);
if (!leaseFile || !requestsJson) { process.stderr.write("usage: lease.mjs <lease.json> '<json array of {method, params}>' [--watch <seconds>]\n"); process.exit(2); }
const watchIdx = rest.indexOf('--watch');
const watchMs = watchIdx >= 0 ? Number(rest[watchIdx + 1]) * 1000 : 3000;
const full = rest.includes('--full');
const answerIdx = rest.indexOf('--answer');
const answer = answerIdx >= 0 ? JSON.parse(rest[answerIdx + 1]) : undefined;
const lease = JSON.parse(fs.readFileSync(leaseFile, 'utf8'));
const requests = JSON.parse(requestsJson);

const sock = net.connect(lease.socketPath);
let buf = '';
let nextId = 1;
const waiting = new Map();
const notes = {};
const lines = [];
let authed = null;
sock.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (authed) { authed(msg); authed = null; continue; }
    if (msg.id !== undefined && waiting.has(msg.id) && msg.method === undefined) { waiting.get(msg.id)(msg); waiting.delete(msg.id); continue; }
    const m = msg.method ?? '(other)';
    const n = (notes[m] ??= { count: 0, first: [] });
    n.count++;
    if (n.first.length < 3) n.first.push(JSON.stringify(msg.params ?? msg).slice(0, 600));
    if (msg.id !== undefined && msg.method) {
      lines.push({ serverRequest: msg.method, id: msg.id, ...(answer !== undefined ? { answered: true } : {}) });
      if (answer !== undefined) sock.write(`${JSON.stringify({ id: msg.id, result: answer })}\n`);
    }
  }
});
const send = (o) => sock.write(`${JSON.stringify(o)}\n`);
const call = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  waiting.set(id, resolve);
  send(params === undefined ? { id, method } : { id, method, params });
  setTimeout(() => { if (waiting.delete(id)) resolve({ id, error: { message: 'no reply in 30 s' } }); }, 30000).unref();
});

await new Promise((resolve, reject) => { sock.once('connect', resolve); sock.once('error', reject); });
const ok = await new Promise((resolve) => { authed = resolve; send({ lease: lease.id, token: lease.token }); });
const out = { auth: ok, replies: [] };
const init = await call('initialize', { clientInfo: { name: 'codexmods-qa', title: null, version: '1' }, capabilities: { experimentalApi: true } });
out.initialize = init.error ?? { userAgent: init.result?.userAgent };
send({ method: 'initialized' });
const results = [];
const ref = /^\$\{(\d+)\.([\w.]+)\}$/;
const fill = (v) => {
  if (typeof v === 'string') { const m = ref.exec(v); return m ? m[2].split('.').reduce((o, k) => o?.[k], results[Number(m[1])]) : v; }
  if (Array.isArray(v)) return v.map(fill);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
  return v;
};
for (const r of requests) {
  if (r.method === '$sleep') { await new Promise((ok) => setTimeout(ok, Number(r.params?.ms) || 1000)); results.push(null); continue; }
  const reply = await call(r.method, fill(r.params));
  results.push(reply.result);
  out.replies.push({ method: r.method, ...(reply.error ? { error: reply.error } : { result: full ? reply.result : JSON.stringify(reply.result).slice(0, 4000) }) });
}
await new Promise((r) => setTimeout(r, watchMs));
out.notifications = notes;
out.serverRequests = lines;
sock.end();
// Exit only once stdout has flushed: a large reply written to a pipe is otherwise cut at 64 KB.
process.stdout.write(`${JSON.stringify(out, null, 1)}\n`, () => process.exit(0));
