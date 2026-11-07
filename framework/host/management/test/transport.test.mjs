import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { rm, stat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createManagement } from '../index.mjs';
import { makeHarness, manifestOf, recordOf } from './fakes.mjs';
import { SOCKETS } from '../../../../contracts/layout.mjs';

async function boot(t) {
  const h = await makeHarness();
  t.after(() => rm(h.root, { recursive: true, force: true }));
  const mgmt = createManagement(h);
  const socketPath = join(h.layout.run, SOCKETS.management);
  const tokenPath = join(h.layout.run, 'mgmt.token');
  const server = await mgmt.listen(socketPath, tokenPath);
  t.after(() => server.dispose());
  const token = (await readFile(tokenPath, 'utf8')).trim();
  return { h, mgmt, server, socketPath, tokenPath, token };
}

/** A line client: collects parsed lines, lets tests await the next N. */
function connect(socketPath) {
  const socket = net.connect(socketPath);
  socket.setEncoding('utf8');
  const lines = [];
  const waiters = [];
  let buf = '';
  let closed = false;
  const closeWaiters = [];
  socket.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      lines.push(JSON.parse(line));
      for (const w of [...waiters]) w();
    }
  });
  socket.on('close', () => { closed = true; closeWaiters.splice(0).forEach((w) => w()); });
  socket.on('error', () => {});
  const next = (n = 1, from = 0) => new Promise((resolve) => {
    const check = () => { if (lines.length >= from + n) { waiters.splice(waiters.indexOf(check), 1); resolve(lines.slice(from, from + n)); } };
    waiters.push(check); check();
  });
  return {
    socket, lines, next,
    send: (obj) => socket.write(`${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`),
    closed: () => (closed ? Promise.resolve() : new Promise((r) => closeWaiters.push(r))),
    end: () => socket.destroy(),
  };
}

test('listen: token is 32 bytes of hex mode 0600, directory 0700, socket private', async (t) => {
  const { h, tokenPath, token, socketPath } = await boot(t);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
  assert.equal((await stat(h.layout.run)).mode & 0o777, 0o700);
  assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
});

test('first request must carry the token; a correct token authenticates the connection', async (t) => {
  const { socketPath, token } = await boot(t);
  const c = connect(socketPath);
  t.after(() => c.end());
  c.send({ id: 1, method: 'mods.list', token });
  c.send({ id: 2, method: 'mods.list' }); // later requests need no token
  const [a, b] = await c.next(2);
  assert.equal(a.ok, true);
  assert.deepEqual(a.result, { mods: [] });
  assert.equal(b.id, 2);
  assert.equal(b.ok, true);
});

test('missing or wrong token: Denied and the connection closes', async (t) => {
  const { socketPath, token } = await boot(t);
  const c1 = connect(socketPath);
  c1.send({ id: 1, method: 'mods.list' });
  const [r1] = await c1.next();
  assert.deepEqual(r1, { id: 1, ok: false, error: { code: 'Denied', message: 'Missing or invalid management token' } });
  await c1.closed();

  const c2 = connect(socketPath);
  c2.send({ id: 7, method: 'mods.list', token: 'f'.repeat(64) });
  c2.send({ id: 8, method: 'mods.list', token });  // same chunk after the failure: must not be answered
  const [r2] = await c2.next();
  assert.equal(r2.error.code, 'Denied');
  await c2.closed();
  assert.equal(c2.lines.length, 1);

  const c3 = connect(socketPath);
  c3.send('this is not json');
  const [r3] = await c3.next();
  assert.equal(r3.error.code, 'Denied');
  await c3.closed();

  const c4 = connect(socketPath);
  c4.send({ id: 9, method: 'mods.list', token: 12345 });
  assert.equal((await c4.next())[0].error.code, 'Denied');
  await c4.closed();
});

test('malformed lines after authentication get Invalid and the connection stays usable', async (t) => {
  const { socketPath, token } = await boot(t);
  const c = connect(socketPath);
  t.after(() => c.end());
  c.send({ id: 1, method: 'mods.list', token });
  c.send('{broken');
  c.send('[1,2]');
  c.send({ method: 'mods.list' });
  c.send({ id: 5, method: 'mods.nope' });
  c.send('');           // blank lines are ignored
  c.send({ id: 6, method: 'mods.list' });
  const got = await c.next(6);
  // Responses are matched by id; lines that could not be parsed carry id null.
  const byId = (id) => got.filter((x) => x.id === id);
  assert.equal(byId(1)[0].ok, true);
  const unparsed = byId(null);
  assert.equal(unparsed.length, 3);
  assert.ok(unparsed.every((x) => x.error.code === 'Invalid'));
  assert.ok(unparsed.some((x) => /Malformed JSON/.test(x.error.message)));
  assert.ok(unparsed.some((x) => /needs a string or number "id"/.test(x.error.message)));
  assert.equal(byId(5)[0].error.message, 'Unknown method "mods.nope"');
  assert.equal(byId(6)[0].ok, true);
});

test('many concurrent connections are served independently', async (t) => {
  const { socketPath, token, h } = await boot(t);
  h.operations.addMod(recordOf(), manifestOf());
  const clients = Array.from({ length: 40 }, () => connect(socketPath));
  t.after(() => clients.forEach((c) => c.end()));
  clients.forEach((c, i) => {
    c.send({ id: `a${i}`, method: 'mods.list', token });
    c.send({ id: `b${i}`, method: 'mods.enable', params: { modId: 'acme.demo' } });
  });
  const results = await Promise.all(clients.map((c) => c.next(2)));
  results.forEach((r, i) => {
    assert.deepEqual(r.map((x) => x.id).sort(), [`a${i}`, `b${i}`]);
    assert.ok(r.every((x) => x.ok));
  });
  assert.equal(h.operations.started.length, 40);
  const opIds = new Set(results.flatMap((r) => r.filter((x) => x.result.opId).map((x) => x.result.opId)));
  assert.equal(opIds.size, 40);
});

test('events.subscribe streams events on that connection only, response first', async (t) => {
  const { socketPath, token, h } = await boot(t);
  h.operations.addMod(recordOf(), manifestOf());
  const sub = connect(socketPath);
  const other = connect(socketPath);
  t.after(() => { sub.end(); other.end(); });
  sub.send({ id: 1, method: 'events.subscribe', token });
  other.send({ id: 1, method: 'mods.list', token });
  assert.deepEqual((await sub.next())[0], { id: 1, ok: true, result: { subscribed: true } });
  await other.next();
  const opId = await h.operations.start({ type: 'enable', modId: 'acme.demo' });
  h.operations.update(opId, { outcome: 'succeeded' });
  const [ev] = await sub.next(1, 1);
  assert.equal(ev.event, 'op');
  assert.equal(ev.data.id, opId);
  assert.equal(ev.data.outcome, 'succeeded');
  assert.equal(other.lines.length, 1, 'a non-subscribed connection receives no events');
  sub.end();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.operations.listenerCount, 0, 'closing the connection releases the subscription');
});

test('dispose closes connections and removes the socket and token', async (t) => {
  const { socketPath, tokenPath, token, server } = await boot(t);
  const c = connect(socketPath);
  c.send({ id: 1, method: 'mods.list', token });
  await c.next();
  await server.dispose();
  await c.closed();
  await assert.rejects(stat(socketPath), { code: 'ENOENT' });
  await assert.rejects(stat(tokenPath), { code: 'ENOENT' });
});

test('a stale socket file is replaced; a live Host is a Conflict', async (t) => {
  const { h, mgmt, socketPath, tokenPath } = await boot(t);
  await assert.rejects(mgmt.listen(socketPath, tokenPath), { code: 'Conflict' });
  const stale = join(h.layout.run, 'stale.sock');
  const s = net.createServer().listen(stale);
  await new Promise((r) => s.once('listening', r));
  s.close();
  // net server.close() unlinks; recreate a plain leftover file to model a crashed Host.
  await writeFile(stale, '');
  const again = await createManagement(h).listen(stale, join(h.layout.run, 'other.token'));
  await again.dispose();
});

test('attach: the same objects over a RealmPort, no token', async (t) => {
  const h = await makeHarness();
  t.after(() => rm(h.root, { recursive: true, force: true }));
  h.operations.addMod(recordOf(), manifestOf());
  const mgmt = createManagement(h);
  const posted = [];
  let onMsg; let onClose;
  const port = {
    post: (m) => posted.push(m),
    onMessage: (fn) => { onMsg = fn; return { dispose() { onMsg = null; } }; },
    onClose: (fn) => { onClose = fn; return { dispose() { onClose = null; } }; },
  };
  const att = mgmt.attach(port);
  onMsg({ id: 1, method: 'mods.list' });
  onMsg({ id: 2, method: 'events.subscribe' });
  onMsg('garbage');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(posted.find((m) => m.id === 1).result.mods[0].id, 'acme.demo');
  assert.deepEqual(posted.find((m) => m.id === 2), { id: 2, ok: true, result: { subscribed: true } });
  assert.equal(posted.find((m) => m.error?.code === 'Invalid')?.id, null);
  const opId = await h.operations.start({ type: 'enable', modId: 'acme.demo' });
  h.operations.update(opId, { outcome: 'succeeded' });
  assert.equal(posted.at(-1).event, 'op');
  onClose();
  assert.equal(h.operations.listenerCount, 0);
  const n = posted.length;
  h.operations.update(opId, { note: 'x' });
  assert.equal(posted.length, n);
  att.dispose();
});
