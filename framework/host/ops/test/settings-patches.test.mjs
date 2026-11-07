// Settings patches (docs/design/systems.md S14, "E3 in detail"): set and unset one key at one scope under the mod's lock, the app map and
// the overrides in their two files, nothing written when nothing changes, waiting their turn behind the mod's operation, and refused at
// once when the mod itself asks then.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';

const withH = (fn, o) => async () => { const H = await harness(o); try { await fn(H); } finally { await H.cleanup(); } };
const rejectsCode = (p, code) => assert.rejects(p, (e) => { assert.equal(e.code, code, e.message); return true; });
const V2 = [
  { key: 'model', kind: 'choice', title: 'Model', description: 'Which model', default: 'sonnet', scope: 'thread', options: [{ value: 'haiku', label: 'Haiku' }, { value: 'sonnet', label: 'Sonnet' }] },
  { key: 'limit', kind: 'number', title: 'Limit', description: 'How many', default: 3, scope: 'app', min: 1, max: 9 },
];
const T = { provider: 'codex', id: 't1' };
/** An activation held until released; `reached` once the operation is in it (it then holds the mod's lock). */
function gate(H) {
  let open, entered;
  const reached = new Promise((r) => { entered = r; });
  const opened = new Promise((r) => { open = r; });
  H.runtime.activateGate = () => { entered(); return opened; };
  return { reached, release: () => { H.runtime.activateGate = null; open(); } };
}
const read = async (H, f) => { try { return JSON.parse(await H.readData('test.alpha', f)); } catch { return null; } };

test('patches: the app map and the scopes in their files, the running mod told what changed; nothing written when nothing changes', withH(async (H) => {
  await H.installApprove({ settings: V2 });
  await H.run({ type: 'enable', modId: 'test.alpha' });
  let op = await H.run({ type: 'configure', modId: 'test.alpha', patches: [{ key: 'model', scope: 'app', value: 'haiku' }, { key: 'model', scope: { thread: T }, value: 'sonnet' }] });
  assert.equal(op.outcome, 'succeeded');
  assert.deepEqual(await read(H, 'settings.json'), { model: 'haiku' });
  assert.deepEqual(await read(H, 'settings.scopes.json'), { 'thread:codex:t1': { model: 'sonnet' } });
  const [[modId, doc, changes]] = H.runtime.names('settingsChanged');
  assert.deepEqual([modId, doc, changes], ['test.alpha', { model: 'haiku', limit: 3 }, [{ key: 'model', scope: 'app' }, { key: 'model', scope: 'thread:codex:t1' }]]);
  op = await H.run({ type: 'configure', modId: 'test.alpha', patches: [{ key: 'model', scope: 'app', value: 'haiku' }] });
  assert.deepEqual([op.outcome, op.note, op.phases.length], ['succeeded', 'Unchanged.', 0]);
  await H.run({ type: 'configure', modId: 'test.alpha', patches: [{ key: 'model', scope: { thread: T }, unset: true }] });
  assert.deepEqual(await read(H, 'settings.scopes.json'), {}, 'the empty scope goes');
  await rejectsCode(H.ops.start({ type: 'configure', modId: 'test.alpha', patches: [{ key: 'limit', scope: { thread: T }, value: 2 }] }), 'Invalid');
  await rejectsCode(H.ops.start({ type: 'configure', modId: 'test.alpha', patches: [{ key: 'limit', scope: 'app', value: 12 }] }), 'Invalid');
  await rejectsCode(H.ops.start({ type: 'configure', modId: 'test.alpha', patches: [] }), 'Invalid');
}));

test('concurrent patches all keep: they wait their turn in order behind the running operation; one that waits too long is refused, and so is the mod\'s own', withH(async (H) => {
  await H.installApprove({ settings: V2 });
  const { release, reached } = gate(H);
  const enabling = await H.ops.start({ type: 'enable', modId: 'test.alpha' });   // holds the mod's lock while it activates
  await reached;
  const a = H.ops.start({ type: 'configure', modId: 'test.alpha', patches: [{ key: 'model', scope: 'app', value: 'haiku' }] });
  const b = H.ops.start({ type: 'configure', modId: 'test.alpha', patches: [{ key: 'limit', scope: 'app', value: 7 }] });
  // The mod's own patch while an operation of it runs (it may be that operation's activation): refused at once, never waiting.
  await rejectsCode(H.ops.start({ type: 'configure', modId: 'test.alpha', patches: [{ key: 'limit', scope: 'app', value: 2 }] }, { fromMod: true }), 'Conflict');
  release();
  await H.ops.whenSettled(enabling);
  for (const id of await Promise.all([a, b])) assert.equal((await H.ops.whenSettled(id)).outcome, 'succeeded');
  assert.deepEqual(await read(H, 'settings.json'), { model: 'haiku', limit: 7 }, 'both kept');
}));

test('a patch that waits longer than its bound is refused, and nothing is written', withH(async (H) => {
  await H.installApprove({ settings: V2 });
  const { release, reached } = gate(H);
  const enabling = await H.ops.start({ type: 'enable', modId: 'test.alpha' });
  await reached;
  await rejectsCode(H.ops.start({ type: 'configure', modId: 'test.alpha', patches: [{ key: 'limit', scope: 'app', value: 5 }] }), 'Conflict');
  release();
  await H.ops.whenSettled(enabling);
  assert.equal(await read(H, 'settings.json'), null);
}, { patchWaitMs: 50 }));

test('the mod\'s own patch waits behind a settings change (it may answer its notification), never behind its activation', withH(async (H) => {
  await H.installApprove({ settings: V2 });
  await H.run({ type: 'enable', modId: 'test.alpha' });
  // While a patch notifies the mod, the mod sets another key: it waits its turn, then both are stored.
  let ownId = null;
  H.runtime.settingsChanged = function settingsChanged() { if (!ownId) ownId = H.ops.start({ type: 'configure', modId: 'test.alpha', patches: [{ key: 'limit', scope: 'app', value: 5 }] }, { fromMod: true }); };
  const first = await H.run({ type: 'configure', modId: 'test.alpha', patches: [{ key: 'model', scope: 'app', value: 'haiku' }] });
  assert.equal(first.outcome, 'succeeded');
  assert.equal((await H.ops.whenSettled(await ownId)).outcome, 'succeeded');
  assert.deepEqual(await read(H, 'settings.json'), { model: 'haiku', limit: 5 });
}));


test('a last-known-good restore writes both files back, and removes the overrides where the generation had none', withH(async (H) => {
  await H.installApprove({ settings: V2 }, { enable: true });
  await H.run({ type: 'configure', modId: 'test.alpha', patches: [{ key: 'model', scope: 'app', value: 'haiku' }, { key: 'model', scope: { thread: T }, value: 'haiku' }] });
  const record = H.ops.state().mods['test.alpha'];
  const gen = (extra) => ({ n: 2, appBuild: 'b', frameworkVersion: '1', adapterVersion: '1', mods: [], settingsHash: '', createdAt: 'x',
    state: { schemaVersion: 1, safeMode: false, nextInstallSeq: 2, mods: { 'test.alpha': { ...record } } }, settings: { 'test.alpha': { limit: 4 } }, ...extra });
  assert.deepEqual((await H.ops.restoreFromGeneration(gen({ settingsScopes: { 'test.alpha': { 'thread:codex:t1': { model: 'sonnet' } } } }))).restored, ['test.alpha']);
  assert.deepEqual(await read(H, 'settings.json'), { limit: 4 });
  assert.deepEqual(await read(H, 'settings.scopes.json'), { 'thread:codex:t1': { model: 'sonnet' } });
  await H.ops.restoreFromGeneration(gen({ settingsScopes: {} }));
  assert.equal(await read(H, 'settings.scopes.json'), null, 'the generation had none');
  await H.writeData('test.alpha', '{"thread:codex:t1":{"model":"haiku"}}', 'settings.scopes.json');
  await H.ops.restoreFromGeneration(gen({}));
  assert.deepEqual(await read(H, 'settings.scopes.json'), { 'thread:codex:t1': { model: 'haiku' } }, 'an older generation knew no overrides: left as they are');
}));

test('E6: a clear patch removes a stored override however it stands now (a value no longer valid, a key no longer declared); never at the app', withH(async (H) => {
  await H.installApprove({ settings: V2 });
  await H.writeData('test.alpha', JSON.stringify({ 'thread:codex:t1': { model: 'opus', gone: true }, 'project:codex:p1': { model: 'haiku' } }), 'settings.scopes.json');
  const op = await H.run({ type: 'configure', modId: 'test.alpha', patches: [{ key: 'model', scope: 'thread:codex:t1', clear: true }, { key: 'gone', scope: { thread: T }, clear: true }] });
  assert.equal(op.outcome, 'succeeded');
  assert.deepEqual(await read(H, 'settings.scopes.json'), { 'project:codex:p1': { model: 'haiku' } });
  await rejectsCode(H.ops.start({ type: 'configure', modId: 'test.alpha', patches: [{ key: 'model', scope: 'app', clear: true }] }), 'Invalid');
}));

test('E6 review: what a mod stored is cleared once it declares no settings at all; a clear interrupted after its write recovers as done', withH(async (H) => {
  await H.installApprove({});   // no settings declared
  await H.writeData('test.alpha', JSON.stringify({ 'thread:codex:t1': { model: 'opus' }, 'project:codex:p1': { model: 'haiku' } }), 'settings.scopes.json');
  await rejectsCode(H.ops.start({ type: 'configure', modId: 'test.alpha', patches: [{ key: 'model', scope: 'app', value: 'x' }] }), 'Invalid');
  let op = await H.run({ type: 'configure', modId: 'test.alpha', patches: [{ key: 'model', scope: 'thread:codex:t1', clear: true }] });
  assert.equal(op.outcome, 'succeeded', JSON.stringify(op));
  assert.deepEqual(await read(H, 'settings.scopes.json'), { 'project:codex:p1': { model: 'haiku' } });
  // a crash after the write: recovery reads the file, not the declarations
  const { crashAt, crashed } = H.crashAt('write:done');
  const dying = H.create({ crashAt });
  const id = await dying.start({ type: 'configure', modId: 'test.alpha', patches: [{ key: 'model', scope: 'project:codex:p1', clear: true }] });
  await crashed;
  await new Promise((r) => setTimeout(r, 20));
  const next = H.create();
  await next.recover();
  op = next.get(id);
  assert.equal(op.outcome, 'succeeded', JSON.stringify(op));
  assert.deepEqual(await read(H, 'settings.scopes.json'), {});
}));
