// Every capture in tests/fixtures/captures replays to its end through the strict fake app-server when a client sends exactly its client
// steps, and every captured payload matches its build's schema and that of every newer build (integration.md §12: fixtures replay; shapes are checked against real frames).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCapture, replayEnv, buildsSince } from './captures.mjs';
import { frameIssues } from './schema-check.mjs';

const DIR = fileURLToPath(new URL('./captures/', import.meta.url));
const FAKE = fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url));
const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));

/** Drive the fake through one session's script: send its client steps, expect its notifications and server requests in order. */
async function drive(file, label, script) {
  const p = spawn(process.execPath, [FAKE, 'app-server', '--name', label], { env: { ...process.env, ...replayEnv(file) }, stdio: ['pipe', 'pipe', 'pipe'] });
  const inbox = [], waiting = new Map();
  let buf = '', err = '';
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
  let seq = 0;
  const write = (m) => p.stdin.write(`${JSON.stringify(m)}\n`);
  const request = (method, params) => new Promise((r) => { const id = `t-${++seq}`; waiting.set(id, r); write({ id, method, ...(params === undefined ? {} : { params }) }); });
  const next = async (pred, what) => {
    const end = Date.now() + 5000;
    for (;;) {
      const at = inbox.findIndex(pred);
      if (at >= 0) return inbox.splice(at, 1)[0];
      if (Date.now() > end) throw new Error(`${what} did not arrive (stderr: ${err})`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  try {
    for (const [i, s] of script.entries()) {
      if ('client' in s) {
        const r = await request(s.client, s.params);
        if ('error' in s) assert.deepEqual(r.error, s.error, `step ${i}`); else assert.deepEqual(r.result, s.result, `step ${i} ${s.client}`);
      } else if ('clientNotification' in s) write({ method: s.clientNotification, ...(s.params === undefined ? {} : { params: s.params }) });
      else if ('notify' in s) {
        const m = await next((x) => x.id === undefined, `step ${i} ${s.notify}`);
        assert.equal(m.method, s.notify, `step ${i}: notifications arrive in captured order`);
        assert.deepEqual(m.params, s.params);
      } else {
        const m = await next((x) => x.id !== undefined && x.method !== undefined, `step ${i} ${s.serverRequest}`);
        assert.equal(m.method, s.serverRequest);
        write({ id: m.id, result: s.answer ?? {} });
      }
    }
    const status = (await request('fake/replay/status')).result;
    assert.deepEqual([status.done, status.refusals], [true, []]);
  } finally { p.kill(); }
}

test('captures: there is at least one, and each names its build in its file name', () => {
  assert.ok(files.length >= 1);
  for (const f of files) assert.ok(f.includes(loadCapture(join(DIR, f)).build), f);
});

for (const f of files) {
  test(`replay: ${f} plays to its end through the strict fake`, async () => {
    const file = join(DIR, f);
    const c = loadCapture(file);
    for (const [label, script] of Object.entries(c.sessions)) await drive(file, label, script);
  });

  test(`shapes: every payload in ${f} matches the schema of its build and of every newer one`, () => {
    const c = loadCapture(join(DIR, f));
    const issues = [];
    for (const script of Object.values(c.sessions)) {
      for (const s of script) {
        const checks = 'client' in s
          ? [['params', s.client, s.params ?? {}], ...('result' in s ? [['result', s.client, s.result]] : [])]
          : 'notify' in s ? [['notification', s.notify, s.params]]
            : 'serverRequest' in s ? [['serverRequest', s.serverRequest, s.params], ...('answer' in s ? [['answer', s.serverRequest, s.answer]] : [])]
              : [['clientNotification', s.clientNotification, s.params ?? {}]];
        for (const [part, method, v] of checks) for (const b of buildsSince(c.build)) for (const i of frameIssues(b, part, method, v)) issues.push(`${b} ${part} ${method}: ${i.path} ${i.message}`);
      }
    }
    assert.deepEqual(issues, []);
  });
}
