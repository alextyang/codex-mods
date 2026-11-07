// Mux addition 8 (docs/design/runtime-core.md R16): a request from a client other than the app that changes Codex state or reaches outside
// it is claimed in the intent journal before it is written to the backend; reads and the app's own requests are not; a caller holding a
// graph intent is not claimed twice; a request the backend never answered is uncertain. Headless: the real mux and the strict fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { harness, leaseConnect, until } from './helpers.mjs';
import { openJournal } from '../../graph/journal.mjs';

const A = 'mod:a';
const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

async function withJournal(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mux-a8-'));
  const file = path.join(dir, 'intents.jsonl');
  const journal = openJournal(file);
  const h = await harness({ journal });
  try { await h.up(); await fn(h, file, journal); } finally { await h.close(); journal.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('A8 1: a lease\'s mutating request is claimed before it reaches the backend and finished by its reply; reads and the app are not claimed', async () => {
  await withJournal(async (h, file) => {
    const t = (await h.app.request(1, 'thread/start', {})).result.thread.id;
    await h.app.request(2, 'thread/name/set', { threadId: t, name: 'by the app' });
    const c = await leaseConnect(h.sock, h.mux.issueLease(A, 'qa'));
    await c.waitFor((m) => m.ok === true);
    await c.request('i', 'initialize', { clientInfo: { name: 'lease', version: '0' } });
    await c.request(3, 'thread/list', {});
    await c.request(4, 'thread/name/set', { threadId: t, name: 'by a lease' });
    const es = lines(file);
    const started = es.filter((e) => e.phase === 'started');
    assert.deepEqual(started.map((e) => [e.source, e.operation]), [['mux', 'thread/name/set']], 'only the lease\'s rename: not its read, not the app\'s rename');
    assert.match(started[0].caller, /^client:/);
    assert.ok(es.some((e) => e.id === started[0].id && e.phase === 'done'));
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /by a lease/, 'arguments are digested');
  });
});

test('A8 2: an in-process client that passes the graph intent it carries out is not claimed again', async () => {
  await withJournal(async (h, file) => {
    const t = (await h.app.request(1, 'thread/start', {})).result.thread.id;
    const mod = h.mux.client(A);
    await mod.request('thread/name/set', { threadId: t, name: 'x' }, { intent: 'graph-intent-1' });
    assert.equal(lines(file).filter((e) => e.phase === 'started').length, 0);
    await mod.request('thread/name/set', { threadId: t, name: 'y' });
    assert.equal(lines(file).filter((e) => e.phase === 'started').length, 1);
  });
});

test('A8 3: a claimed request the backend never answered is uncertain, reported until acknowledged', async () => {
  await withJournal(async (h, file, journal) => {
    const mod = h.mux.client(A);
    const pending = mod.request('fake/slow', { ms: 60_000 }).catch((e) => e);
    await until(() => lines(file).some((e) => e.phase === 'started' && e.operation === 'fake/slow'), 5000, 'claimed');
    h.app.send({ id: 9, method: 'fake/exit', params: { code: 1 } });
    const err = await pending;
    assert.equal(err.code, 'OutcomeUnknown');
    const u = journal.uncertain();
    assert.equal(u.length, 1);
    assert.equal(u[0].operation, 'fake/slow');
    assert.ok(journal.markSurfaced(u[0].id));
    assert.deepEqual(journal.uncertain(), []);
  });
});
