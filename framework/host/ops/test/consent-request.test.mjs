// What waits for consent (docs/design/systems.md "E6 in detail", decision 9): a consent names the request the user reviewed and is refused
// once another waits; `enable` belongs to an install's consent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { consentRequestOf } from '../consent.mjs';

const ID = 'test.alpha';
const rejectsCode = (p, code) => assert.rejects(p, (e) => { assert.equal(e.code, code, e.message); return true; });

test('E6: a consent names what was reviewed: a stale request is refused, the current one applies; an update keeps the mod as it is', async () => {
  const H = await harness();
  try {
    const requestNow = () => consentRequestOf(H.ops.state().mods[ID], H.ops.installed(ID)?.manifest);
    await H.run({ type: 'install', source: await H.pack({ id: ID, permissions: ['ui'] }) });
    const install = requestNow();
    assert.deepEqual([install.kind, install.version, install.permissions, install.addedPermissions], ['install', '1.0.0', ['ui'], ['ui']]);
    assert.match(install.id, /^[0-9a-f]{16}$/);
    await rejectsCode(H.ops.start({ type: 'consent', modId: ID, approve: true, request: 'nope' }), 'Invalid');
    let op = await H.run({ type: 'consent', modId: ID, approve: true, request: 'f'.repeat(16) });
    assert.equal(op.outcome, 'failed');
    assert.equal(op.error.code, 'Conflict', 'not what was reviewed');
    assert.equal(H.ops.state().mods[ID].status, 'pending-consent');
    op = await H.run({ type: 'consent', modId: ID, approve: true, request: install.id });
    assert.equal(op.outcome, 'succeeded', JSON.stringify(op));
    assert.equal(requestNow(), null, 'nothing waits');
    // an update that asks more waits; its request is not the install's
    op = await H.run({ type: 'update', modId: ID, source: await H.pack({ id: ID, version: '1.1.0', permissions: ['ui', 'network'] }) });
    assert.equal(op.awaiting, 'consent');
    const update = requestNow();
    assert.deepEqual([update.kind, update.version, update.addedPermissions, update.permissions], ['update', '1.1.0', ['network'], ['network', 'ui']]);
    assert.notEqual(update.id, install.id);
    // the mod is off: approving its update with enable is refused (it keeps the mod as it is)
    await rejectsCode(H.ops.start({ type: 'consent', modId: ID, approve: true, enable: true, request: update.id }), 'Invalid');
    op = await H.run({ type: 'consent', modId: ID, approve: true, request: update.id });
    assert.equal(op.outcome, 'succeeded', JSON.stringify(op));
    assert.deepEqual([H.ops.state().mods[ID].version, H.ops.state().mods[ID].status], ['1.1.0', 'disabled']);
  } finally { await H.cleanup(); }
});
