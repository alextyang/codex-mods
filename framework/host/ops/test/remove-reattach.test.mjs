import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { harness, keygen } from './harness.mjs';
import { cloneDir } from '../fsops.mjs';
import { publisherFingerprint } from '../../../../contracts/layout.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const withH = (fn, o) => async () => { const H = await harness(o); try { await fn(H); } finally { await H.cleanup(); } };
const rejectsCode = (p, code) => assert.rejects(p, (e) => { assert.equal(e.code, code, e.message); return true; });
const names = (op) => op.phases.map((p) => p.name);
const MIGRATE = { 'migrate.js': 'export function migrate() {}\n' };

async function seedMod(H, id = 'test.alpha', over = {}) {
  await H.installApprove({ id, ...over }, { enable: true });
  await H.writeData(id, 'data-1');
  await H.writeData(id, '{"x":1}', 'settings.json');
  await mkdir(join(H.L.retained, id), { recursive: true });
  await writeFile(join(H.L.retained, id, 'store.json'), 'retained');
  await mkdir(join(H.L.backends, id, 'b1'), { recursive: true });
  await mkdir(join(H.L.snapshots, id, '0.9.0'), { recursive: true });
}

test('remove keep-data: stops, moves data to orphaned/, keeps retained storage and secrets, forgets the record', withH(async (H) => {
  await seedMod(H);
  const op = await H.run({ type: 'remove', modId: 'test.alpha', deleteData: false });
  assert.equal(op.outcome, 'succeeded', JSON.stringify(op));
  assert.deepEqual(names(op), ['stop', 'move-data', 'unrecord']);
  assert.equal(H.ops.state().mods['test.alpha'], undefined);
  assert.equal((await H.readState()).mods['test.alpha'], undefined);
  assert.equal(await H.orphanData('test.alpha'), 'data-1');
  assert.equal(await H.exists(join(H.L.data, 'test.alpha')), false);
  assert.equal(await readFile(join(H.L.retained, 'test.alpha', 'store.json'), 'utf8'), 'retained');
  assert.ok(await H.exists(join(H.L.backends, 'test.alpha')));
  assert.deepEqual(H.runtime.names('deleteSecrets'), []);
  assert.deepEqual(H.runtime.names('deactivate').at(-1), ['test.alpha', 'remove']);
  assert.deepEqual(H.mux.disposed, ['mod:test.alpha']);
}));

test('remove delete-data: deletes data, retained, snapshots, orphaned, backends, secrets', withH(async (H) => {
  await seedMod(H);
  await mkdir(join(H.L.orphaned, 'test.alpha'), { recursive: true });
  const op = await H.run({ type: 'remove', modId: 'test.alpha', deleteData: true });
  assert.equal(op.outcome, 'succeeded', JSON.stringify(op));
  assert.deepEqual(names(op), ['stop', 'unrecord', 'delete-data']);
  for (const dir of [H.L.data, H.L.retained, H.L.snapshots, H.L.orphaned, H.L.backends]) assert.deepEqual(await H.ls(join(dir, 'test.alpha')), [], dir);
  assert.deepEqual(H.runtime.names('deleteSecrets'), [['test.alpha', publisherFingerprint(H.key.publicKey)]]);
  assert.deepEqual(H.mux.disposed, ['mod:test.alpha']);
  assert.equal(H.ops.state().mods['test.alpha'], undefined);
}));

test('remove of a development package deletes secrets under the "dev" fingerprint', withH(async (H) => {
  const dir = await H.devDir({ id: 'dev.mod' });
  await H.run({ type: 'install', source: dir, dev: true });
  await H.run({ type: 'consent', modId: 'dev.mod', approve: true });
  await H.run({ type: 'remove', modId: 'dev.mod', deleteData: true });
  assert.deepEqual(H.runtime.names('deleteSecrets'), [['dev.mod', 'dev']]);
}));

test('reattach: orphaned data comes back under data/<id> (same schema); provenance checked', withH(async (H) => {
  await seedMod(H);
  await H.run({ type: 'remove', modId: 'test.alpha', deleteData: false });
  await rejectsCode(H.ops.start({ type: 'reattach', modId: 'test.alpha' }), 'Invalid');       // not installed
  await H.installApprove();
  const op = await H.run({ type: 'reattach', modId: 'test.alpha' });
  assert.equal(op.outcome, 'succeeded', JSON.stringify(op));
  assert.deepEqual(names(op), ['attach', 'finish']);
  assert.equal(await H.readData('test.alpha'), 'data-1');
  assert.deepEqual(await H.ls(join(H.L.orphaned)), []);
  await rejectsCode(H.ops.start({ type: 'reattach', modId: 'test.alpha' }), 'Invalid');       // nothing orphaned any more
}));

test('reattach migrates data whose schema is older; a failed migration leaves the orphan untouched', withH(async (H) => {
  await seedMod(H);
  await H.run({ type: 'remove', modId: 'test.alpha', deleteData: false });
  await H.installApprove({ version: '2.0.0', data: { schemaVersion: 2, migrate: 'migrate.js' } }, { files: MIGRATE });
  H.runtime.migrate = async () => { throw new Error('migration exploded'); };
  let op = await H.run({ type: 'reattach', modId: 'test.alpha' });
  assert.equal(op.outcome, 'failed');
  assert.match(op.error.message, /migration exploded/);
  assert.equal(await H.orphanData('test.alpha'), 'data-1');
  assert.equal(await H.exists(join(H.L.data, 'test.alpha')), false);
  assert.deepEqual((await H.ls(H.L.data)).filter((n) => n.startsWith('.')), []);
  H.runtime.migrate = async (o) => { assert.equal(o.from, 0); assert.equal(o.to, 2); await writeFile(join(o.stagedDataDir, 'store.json'), 'data-2'); };
  op = await H.run({ type: 'reattach', modId: 'test.alpha' });
  assert.equal(op.outcome, 'succeeded', JSON.stringify(op));
  assert.deepEqual(names(op), ['stage', 'migrate', 'attach', 'finish']);
  assert.equal(await H.readData('test.alpha'), 'data-2');
  assert.equal(H.ops.state().mods['test.alpha'].dataSchemaVersion, 2);
  assert.deepEqual(await H.ls(H.L.orphaned), []);
}));

test('reattach: newer orphaned data, a different publisher or existing data are refused', withH(async (H) => {
  await H.installApprove({ version: '2.0.0', data: { schemaVersion: 2 } }, { enable: true });
  await H.writeData('test.alpha', 'new-schema');
  await H.run({ type: 'remove', modId: 'test.alpha', deleteData: false });
  await H.installApprove({ version: '1.0.0' });                                                  // older code, schema 0
  await assert.rejects(H.ops.start({ type: 'reattach', modId: 'test.alpha' }), /schema 2, newer than/);
  await H.run({ type: 'remove', modId: 'test.alpha', deleteData: false });
  // different publisher: remove the pin by reinstalling under another key (orphaned data keeps the old provenance)
  await H.installApprove({ version: '2.0.1', data: { schemaVersion: 2 } }, { k: keygen() });
  await rejectsCode(H.ops.start({ type: 'reattach', modId: 'test.alpha' }), 'Denied');
  await H.run({ type: 'remove', modId: 'test.alpha', deleteData: true });
  // already has data
  await seedMod(H, 'test.beta');
  await H.run({ type: 'remove', modId: 'test.beta', deleteData: false });
  await H.installApprove({ id: 'test.beta' });
  await H.writeData('test.beta', 'something');
  await rejectsCode(H.ops.start({ type: 'reattach', modId: 'test.beta' }), 'Conflict');
}));

test('E6: reattach of an enabled mod is one operation: off, reattached, on again; a failure to turn it on leaves the data and the mod off', withH(async (H) => {
  await seedMod(H);
  await H.run({ type: 'remove', modId: 'test.alpha', deleteData: false });
  await H.installApprove({}, { enable: true });
  let op = await H.run({ type: 'reattach', modId: 'test.alpha' });
  assert.equal(op.outcome, 'succeeded', JSON.stringify(op));
  assert.deepEqual(names(op), ['deactivate', 'disable', 'attach', 'finish', 'compatibility', 'activate', 'commit']);
  assert.equal(await H.readData('test.alpha'), 'data-1');
  assert.equal(H.ops.state().mods['test.alpha'].status, 'enabled');
  assert.deepEqual(H.runtime.names('deactivate').at(-1), ['test.alpha', 'reattach']);
  // again, with activation failing: the data stays attached, the mod off, and the user is told (needs attention)
  await H.run({ type: 'remove', modId: 'test.alpha', deleteData: false });
  await H.installApprove({}, { enable: true });
  H.runtime.activateErrors.set('test.alpha', new Error('activation exploded'));
  op = await H.run({ type: 'reattach', modId: 'test.alpha' });
  assert.equal(op.outcome, 'needs-attention', JSON.stringify(op));
  assert.match(op.note, /data was reattached and the mod is off/);
  assert.equal(await H.readData('test.alpha'), 'data-1');
  assert.equal(H.ops.state().mods['test.alpha'].status, 'disabled');
  // data written while it ran (after the check, before its stop) is never overwritten
  H.runtime.activateErrors.delete('test.alpha');
  await H.run({ type: 'remove', modId: 'test.alpha', deleteData: false });
  await H.installApprove({}, { enable: true });
  const stop = H.runtime.deactivate.bind(H.runtime);
  H.runtime.deactivate = async (id, why) => { await H.writeData(id, 'live'); return stop(id, why); };
  op = await H.run({ type: 'reattach', modId: 'test.alpha' });
  assert.equal(op.outcome, 'needs-attention', JSON.stringify(op));
  assert.match(op.note, /wrote data before it stopped/);
  assert.equal(await H.readData('test.alpha'), 'live');
  assert.equal(await H.orphanData('test.alpha'), 'data-1');
  // E6 review: the same, with a crash after its stop and before the check: recovery sees the mod's own data, not an attach, and never
  // consumes the kept generation
  H.runtime.deactivate = stop;
  await H.run({ type: 'remove', modId: 'test.alpha', deleteData: true });
  await seedMod(H);
  await H.run({ type: 'remove', modId: 'test.alpha', deleteData: false });
  await H.installApprove({}, { enable: true });
  H.runtime.deactivate = async (id, why) => { await H.writeData(id, 'live'); return stop(id, why); };
  const { crashAt, crashed } = H.crashAt('disable:done');
  const dying = H.create({ crashAt });
  const crashedId = await dying.start({ type: 'reattach', modId: 'test.alpha' });
  await crashed;
  await new Promise((r) => setTimeout(r, 20));
  const { FakeRuntime } = await import('./harness.mjs');
  H.runtime = new FakeRuntime();
  const next = H.create();
  await next.recover();
  const after = next.get(crashedId);
  assert.equal(after.outcome, 'needs-attention', JSON.stringify(after));
  assert.match(after.note, /wrote data before it stopped/);
  assert.equal(await H.readData('test.alpha'), 'live');
  assert.equal(await H.orphanData('test.alpha'), 'data-1', 'the kept data is untouched');
  assert.equal(next.state().mods['test.alpha'].status, 'disabled', 'left off');
}));

test('cloneDir falls back to a recursive copy when `cp -c` is unavailable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codexmods-clone-'));
  try {
    await mkdir(join(dir, 'src', 'sub'), { recursive: true });
    await writeFile(join(dir, 'src', 'sub', 'f.txt'), 'hello');
    assert.equal(await cloneDir(join(dir, 'src'), join(dir, 'a'), { cpPath: '/nonexistent/cp' }), 'copy');
    assert.equal(await readFile(join(dir, 'a', 'sub', 'f.txt'), 'utf8'), 'hello');
    const how = await cloneDir(join(dir, 'src'), join(dir, 'b'));
    assert.ok(how === 'clone' || how === 'copy');
    assert.equal(await readFile(join(dir, 'b', 'sub', 'f.txt'), 'utf8'), 'hello');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ orphan generations (contracts v1.13)
async function removeKeepWith(H, text) {
  await H.installApprove({}, { enable: true });
  await H.writeData('test.alpha', text);
  const op = await H.run({ type: 'remove', modId: 'test.alpha', deleteData: false });
  assert.equal(op.outcome, 'succeeded', JSON.stringify(op));
  await new Promise((r) => setTimeout(r, 3));       // generations are named by timestamp
}

test('repeated keep-data removals preserve every dataset as its own generation', withH(async (H) => {
  await removeKeepWith(H, 'first');
  await removeKeepWith(H, 'second');
  await removeKeepWith(H, 'third');
  const gens = await H.orphanGens('test.alpha');
  assert.equal(gens.length, 3);
  assert.deepEqual(await Promise.all(gens.map((g) => H.orphanData('test.alpha', g))), ['first', 'second', 'third']);
  const meta = JSON.parse(await H.orphanData('test.alpha', gens[1], '.orphan.json'));
  assert.deepEqual([meta.publisher, meta.version, meta.dataSchemaVersion, meta.removedAt], [H.key.publicKey, '1.0.0', 0, gens[1]]);
  const listed = await H.ops.orphanedGenerations('test.alpha');
  assert.deepEqual(listed.map((g) => g.at), [...gens].reverse());                          // newest first
  assert.deepEqual(listed[0], { at: gens[2], version: '1.0.0', dataSchemaVersion: 0 });
}));

test('reattach takes the newest generation by default, or the one named; others stay, provenance file does not leak into data/', withH(async (H) => {
  await removeKeepWith(H, 'first');
  await removeKeepWith(H, 'second');
  await removeKeepWith(H, 'third');
  const [g1, g2] = await H.orphanGens('test.alpha');
  await H.installApprove();
  await rejectsCode(H.ops.start({ type: 'reattach', modId: 'test.alpha', generation: '2001-01-01T00:00:00.000Z' }), 'Invalid');
  await rejectsCode(H.ops.start({ type: 'reattach', modId: 'test.alpha', generation: '../etc' }), 'Invalid');
  let op = await H.run({ type: 'reattach', modId: 'test.alpha' });
  assert.equal(op.outcome, 'succeeded', JSON.stringify(op));
  assert.equal(op.input.generation, undefined);
  assert.equal(await H.readData('test.alpha'), 'third');
  assert.equal(await H.readData('test.alpha', '.orphan.json'), undefined);
  assert.deepEqual(await H.orphanGens('test.alpha'), [g1, g2]);
  // a named, older generation (the mod must have no data: remove it again first)
  await H.run({ type: 'remove', modId: 'test.alpha', deleteData: false });
  await H.installApprove();
  assert.equal((await H.orphanGens('test.alpha')).length, 3);
  op = await H.run({ type: 'reattach', modId: 'test.alpha', generation: g1 });
  assert.equal(op.outcome, 'succeeded', JSON.stringify(op));
  assert.equal(await H.readData('test.alpha'), 'first');
  assert.ok(!(await H.orphanGens('test.alpha')).includes(g1));
  assert.equal((await H.orphanGens('test.alpha')).length, 2);
}));

test('reattach of a generation with an older schema migrates a clone without the provenance file', withH(async (H) => {
  await removeKeepWith(H, 'old-schema');
  await H.installApprove({ version: '2.0.0', data: { schemaVersion: 2, migrate: 'migrate.js' } }, { files: MIGRATE });
  H.runtime.migrate = async (o) => {
    assert.equal(await readFile(join(o.stagedDataDir, 'store.json'), 'utf8'), 'old-schema');
    assert.equal(await H.exists(join(o.stagedDataDir, '.orphan.json')), false);
    await writeFile(join(o.stagedDataDir, 'store.json'), 'new-schema');
  };
  const op = await H.run({ type: 'reattach', modId: 'test.alpha' });
  assert.equal(op.outcome, 'succeeded', JSON.stringify(op));
  assert.equal(await H.readData('test.alpha'), 'new-schema');
  assert.equal(await H.readData('test.alpha', '.orphan.json'), undefined);
  assert.deepEqual(await H.ls(H.L.orphaned), []);
}));

test('delete-data removal deletes every generation (and nothing else is kept)', withH(async (H) => {
  await removeKeepWith(H, 'first');
  await removeKeepWith(H, 'second');
  await H.installApprove();
  const op = await H.run({ type: 'remove', modId: 'test.alpha', deleteData: true });
  assert.equal(op.outcome, 'succeeded');
  assert.deepEqual(await H.ls(H.L.orphaned), []);
}));
