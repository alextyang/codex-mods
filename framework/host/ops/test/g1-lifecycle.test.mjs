// G1: the full operator lifecycle in one sequence (ARCHITECTURE §11):
// install → consent deny → install → approve → enable → configure → disable → enable → compatible update →
// changed-permission update with consent → rollback → remove keep → reattach → remove delete.
// (reattach needs the mod installed again, so a reinstall + approve sits between remove-keep and reattach.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { harness } from './harness.mjs';
import { publisherFingerprint } from '../../../../contracts/layout.mjs';

const ID = 'g1.mod';
const SETTINGS = [{ key: 'prompt', kind: 'text', title: 'Prompt', default: 'hello' }, { key: 'limit', kind: 'number', title: 'Limit', min: 1, default: 5 }];
const MIGRATE = { 'migrate.js': 'export function migrate() {}\n' };

test('G1: install → deny → install → approve → enable → configure → disable → enable → update → consent update → rollback → remove keep → reattach → remove delete', async () => {
  const H = await harness();
  try {
    const run = async (input) => { const op = await H.run(input); assert.equal(op.outcome, 'succeeded', JSON.stringify(op)); return op; };
    const mod = () => H.ops.state().mods[ID];
    const v100 = await H.pack({ id: ID, version: '1.0.0', permissions: ['ui'], settings: SETTINGS });

    // 1-2. install, then deny consent
    let op = await run({ type: 'install', source: v100 });
    assert.equal(op.awaiting, 'consent');
    assert.equal(mod().status, 'pending-consent');
    await run({ type: 'consent', modId: ID, approve: false });
    assert.equal(mod(), undefined);

    // 3-4. install again, approve (disabled), enable
    await run({ type: 'install', source: v100 });
    assert.equal(mod().installSeq, 2, 'installSeq is never reused');
    await run({ type: 'consent', modId: ID, approve: true });
    assert.equal(mod().status, 'disabled');
    assert.deepEqual(mod().grants, ['ui']);
    await run({ type: 'enable', modId: ID });
    assert.equal(mod().status, 'enabled');

    // 5. configure
    await run({ type: 'configure', modId: ID, patches: [{ key: 'prompt', scope: 'app', value: 'be brief' }] });
    assert.deepEqual(JSON.parse(await H.readData(ID, 'settings.json')), { prompt: 'be brief' });
    assert.deepEqual(H.runtime.names('settingsChanged').at(-1).slice(0, 2), [ID, { prompt: 'be brief', limit: 5 }]);

    // 6-7. disable, enable
    await run({ type: 'disable', modId: ID });
    assert.equal(mod().status, 'disabled');
    assert.ok(!H.runtime.active.has(ID));
    await run({ type: 'enable', modId: ID });
    assert.equal(mod().status, 'enabled');
    assert.ok(H.runtime.active.has(ID));
    await H.writeData(ID, 'state-at-1.1.0');

    // 8. compatible update (same permissions, same schema)
    op = await run({ type: 'update', modId: ID, source: await H.pack({ id: ID, version: '1.1.0', permissions: ['ui'], settings: SETTINGS }) });
    assert.equal(op.awaiting, undefined);
    assert.equal(mod().version, '1.1.0');
    assert.equal(mod().status, 'enabled');

    // 9. changed-permission update: waits for consent while 1.1.0 keeps running, then migrates data schema 0 → 1
    H.runtime.migrate = async (o) => { await writeFile(join(o.stagedDataDir, 'store.json'), 'state-migrated-to-1.2.0'); };
    op = await run({ type: 'update', modId: ID, source: await H.pack({ id: ID, version: '1.2.0', permissions: ['ui', 'network'], settings: SETTINGS, data: { schemaVersion: 1, migrate: 'migrate.js' } }, MIGRATE) });
    assert.equal(op.awaiting, 'consent');
    assert.equal(mod().version, '1.1.0');
    assert.deepEqual(mod().pendingUpdate, { version: '1.2.0', addedPermissions: ['network'] });
    assert.ok(H.runtime.active.has(ID));
    await run({ type: 'consent', modId: ID, approve: true });
    assert.equal(mod().version, '1.2.0');
    assert.deepEqual(mod().grants, ['ui', 'network']);
    assert.equal(mod().dataSchemaVersion, 1);
    assert.equal(await H.readData(ID), 'state-migrated-to-1.2.0');
    assert.equal(await readFile(join(H.L.snapshots, ID, '1.1.0', 'store.json'), 'utf8'), 'state-at-1.1.0');

    // 10. rollback to 1.1.0 with its data
    await run({ type: 'rollback', modId: ID, toVersion: '1.1.0', restoreData: true });
    assert.equal(mod().version, '1.1.0');
    assert.equal(mod().dataSchemaVersion, 0);
    assert.equal(await H.readData(ID), 'state-at-1.1.0');
    assert.deepEqual(mod().grants, ['ui']);
    assert.equal(mod().status, 'enabled');

    // 11. remove, keep data
    await run({ type: 'remove', modId: ID, deleteData: false });
    assert.equal(mod(), undefined);
    assert.equal(await H.orphanData(ID), 'state-at-1.1.0');
    assert.deepEqual(H.runtime.names('deleteSecrets'), []);

    // 12. reinstall (same publisher) and reattach the orphaned data
    await run({ type: 'install', source: await H.pack({ id: ID, version: '1.1.0', permissions: ['ui'], settings: SETTINGS }) });
    await run({ type: 'consent', modId: ID, approve: true });
    assert.equal(mod().installSeq, 3);
    await run({ type: 'reattach', modId: ID });
    assert.equal(await H.readData(ID), 'state-at-1.1.0');
    assert.deepEqual(await H.ls(H.L.orphaned), []);

    // 13. remove, delete data
    await run({ type: 'remove', modId: ID, deleteData: true });
    assert.equal(mod(), undefined);
    for (const dir of [H.L.data, H.L.retained, H.L.snapshots, H.L.orphaned, H.L.backends]) assert.deepEqual(await H.ls(join(dir, ID)), []);
    assert.deepEqual(H.runtime.names('deleteSecrets'), [[ID, publisherFingerprint(H.key.publicKey)]]);
    assert.ok(H.mux.disposed.includes(`mod:${ID}`));

    // the journal tells the whole story, every op succeeded and was published on the bus
    const types = H.ops.list({ modId: ID }).map((o) => `${o.input.type}${o.input.type === 'consent' ? (o.input.approve ? '+' : '-') : ''}`);
    assert.deepEqual(types, [
      'install', 'consent-', 'install', 'consent+', 'enable', 'configure', 'disable', 'enable', 'update', 'update', 'consent+',
      'rollback', 'remove', 'install', 'consent+', 'reattach', 'remove',
    ]);
    assert.ok(H.ops.list({ modId: ID }).every((o) => o.outcome === 'succeeded' && o.endedAt));
    assert.ok(H.bus.published.filter((p) => p.topic === 'framework/op').length >= types.length * 2);
    const disk = await H.readState();
    assert.deepEqual(disk.mods, {});
    assert.equal(disk.nextInstallSeq, 4);
  } finally { await H.cleanup(); }
});
