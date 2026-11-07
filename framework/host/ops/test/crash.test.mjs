// Crash-injection: for every scenario, throw from opts.crashAt at each journaled phase (before its effects: "<phase>")
// and after its effects ("<phase>:done"). A fresh createOperations on the same root plus recover() must end in exactly one
// coherent state (checked against state.json and the data directory), with an outcome that fits that state, without
// ever calling Runtime.activate during recovery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { harness, FakeRuntime, keygen } from './harness.mjs';
import { publisherFingerprint } from '../../../../contracts/layout.mjs';

const MIGRATE = { 'migrate.js': 'export function migrate() {}\n' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = (point) => point.replace(/:done$/, '');
const ID = 'test.alpha';

async function strays(H) {
  const bad = [];
  for (const dir of [H.L.data, join(H.L.snapshots, ID), join(H.L.store, '.staging')]) {
    for (const n of await H.ls(dir)) if (n.startsWith('.tmp-') || n.startsWith('.staging') || n.startsWith('.restore') || (dir.endsWith('.staging'))) bad.push(join(dir, n));
  }
  return bad;
}

// ------------------------------------------------------------------ scenarios
const updateSetup = async (H) => {
  await H.installApprove({}, { enable: true });
  await H.writeData(ID, 'v0-data');
  H.runtime.migrate = async (o) => { await writeFile(join(o.stagedDataDir, 'store.json'), 'v1-data'); };
  H.source = await H.pack({ version: '2.0.0', data: { schemaVersion: 1, migrate: 'migrate.js' } }, MIGRATE);
};
const versionedState = (oldV, newV, oldData, newData, oldSchema, newSchema) => async (H, ops) => {
  const r = ops.state().mods[ID];
  const data = await H.readData(ID);
  assert.equal(r.status, 'enabled');
  if (r.version === oldV && r.dataSchemaVersion === oldSchema && data === oldData) return 'old';
  if (r.version === newV && r.dataSchemaVersion === newSchema && data === newData) return 'new';
  assert.fail(`incoherent: version ${r.version}, schema ${r.dataSchemaVersion}, data ${data}`);
};

const scenarios = [
  {
    name: 'update (enabled, schema change with migration)',
    setup: updateSetup,
    input: (H) => ({ type: 'update', modId: ID, source: H.source }),
    classify: versionedState('1.0.0', '2.0.0', 'v0-data', 'v1-data', 0, 1),
    expect: (p) => ({
      verify: ['old', 'failed'], compatibility: ['old', 'failed'], store: ['old', 'failed'], stop: ['old', 'failed'], snapshot: ['old', 'failed'],
      migrate: ['old', 'failed'], swap: ['old', 'failed'], apply: ['old', 'failed'], activate: ['old', 'needs-attention'],
      health: ['old', 'reverted'], commit: ['new', 'succeeded'],
    })[base(p)],
    required: ['verify', 'compatibility', 'store', 'stop', 'snapshot', 'migrate', 'swap', 'apply', 'activate', 'health', 'commit'],
  },
  {
    name: 'update (enabled, schema change without a migrate script)',
    setup: async (H) => { await H.installApprove({}, { enable: true }); await H.writeData(ID, 'v0-data'); H.source = await H.pack({ version: '2.0.0', data: { schemaVersion: 1 } }); },
    input: (H) => ({ type: 'update', modId: ID, source: H.source }),
    classify: versionedState('1.0.0', '2.0.0', 'v0-data', 'v0-data', 0, 1),
    expect: (p) => ({
      verify: ['old', 'failed'], compatibility: ['old', 'failed'], store: ['old', 'failed'], stop: ['old', 'failed'], snapshot: ['old', 'failed'],
      apply: ['old', 'failed'], activate: ['old', 'needs-attention'], health: ['old', 'reverted'], commit: ['new', 'succeeded'],
    })[base(p)],
    required: ['snapshot', 'apply', 'activate', 'health', 'commit'],
  },
  {
    name: 'update with a publisher change, approved by consent',
    setup: async (H) => {
      await H.installApprove({}, { enable: true });
      await H.writeData(ID, 'v0-data');
      H.newKey = keygen();
      H.runtime.migrate = async (o) => { await writeFile(join(o.stagedDataDir, 'store.json'), 'v1-data'); };
      const up = await H.run({ type: 'update', modId: ID, source: await H.pack({ version: '2.0.0', data: { schemaVersion: 1, migrate: 'migrate.js' } }, MIGRATE, H.newKey) });
      assert.equal(up.awaiting, 'consent');
    },
    input: () => ({ type: 'consent', modId: ID, approve: true }),
    classify: async (H, ops) => {
      const r = ops.state().mods[ID];
      const label = await versionedState('1.0.0', '2.0.0', 'v0-data', 'v1-data', 0, 1)(H, ops);
      assert.equal(r.publisher, label === 'old' ? H.key.publicKey : H.newKey.publicKey, 'the pin follows the version');
      return label;
    },
    expect: (p) => ({
      approve: ['old', 'failed'], stop: ['old', 'failed'], snapshot: ['old', 'failed'], migrate: ['old', 'failed'], swap: ['old', 'failed'], apply: ['old', 'failed'],
      activate: ['old', 'needs-attention'], health: ['old', 'reverted'], commit: ['new', 'succeeded'], cleanup: ['new', 'succeeded'],
    })[base(p)],
    required: ['approve', 'stop', 'apply', 'activate', 'health', 'commit', 'cleanup'],
    extra: async (H, label, point, dead) => {
      const calls = [...dead.names('deleteSecrets'), ...H.runtime.names('deleteSecrets')];
      if (label === 'new') assert.ok(calls.length >= 1, 'old publisher secrets are deleted (also when recovery finishes the op)');
      else assert.deepEqual(calls, [], 'a reverted update never deletes the old publisher\'s secrets');
      assert.ok(calls.every((c) => c[1] === publisherFingerprint(H.key.publicKey)));
    },
  },
  {
    name: 'update that stages an update for consent',
    setup: async (H) => { await H.installApprove({ permissions: ['ui'] }, { enable: true }); H.source = await H.pack({ version: '1.1.0', permissions: ['ui', 'secrets'] }); },
    input: (H) => ({ type: 'update', modId: ID, source: H.source }),
    classify: async (H, ops) => { const r = ops.state().mods[ID]; assert.equal(r.version, '1.0.0'); assert.ok(r.status === 'enabled'); return r.pendingUpdate ? 'pending' : 'none'; },
    expect: (p) => (['verify', 'compatibility', 'store'].includes(base(p)) || p === 'await-consent' ? ['none', 'failed'] : ['pending', 'succeeded']),
    required: ['verify', 'compatibility', 'store', 'await-consent'],
  },
  {
    name: 'rollback with data (snapshot restore)',
    setup: async (H) => {
      await updateSetup(H);
      const up = await H.run({ type: 'update', modId: ID, source: H.source });
      assert.equal(up.outcome, 'succeeded');
      await H.writeData(ID, 'v1-late');
    },
    input: () => ({ type: 'rollback', modId: ID, toVersion: '1.0.0', restoreData: true }),
    classify: versionedState('2.0.0', '1.0.0', 'v1-late', 'v0-data', 1, 0),
    expect: (p) => ({
      stop: ['old', 'failed'], snapshot: ['old', 'failed'], 'restore-data': ['old', 'failed'], apply: ['old', 'failed'], activate: ['old', 'needs-attention'], commit: ['new', 'succeeded'],
    })[base(p)],
    required: ['stop', 'snapshot', 'restore-data', 'apply', 'activate', 'commit'],
  },
  {
    name: 'install',
    setup: async (H) => { H.source = await H.pack(); },
    input: (H) => ({ type: 'install', source: H.source }),
    classify: async (H, ops) => {
      const r = ops.state().mods[ID];
      if (!r) return 'none';
      assert.equal(r.status, 'pending-consent'); assert.equal(r.installSeq, 1); assert.ok(await H.exists(join(H.L.store, ID, '1.0.0', 'mod.json')));
      return 'pending';
    },
    expect: (p) => (p === 'record:done' ? ['pending', 'succeeded'] : ['none', 'failed']),
    required: ['verify', 'compatibility', 'store', 'record'],
  },
  {
    name: 'consent deny of a pending install',
    setup: async (H) => { await H.run({ type: 'install', source: await H.pack() }); },
    input: () => ({ type: 'consent', modId: ID, approve: false }),
    classify: async (H, ops) => (ops.state().mods[ID] ? 'pending' : 'none'),
    expect: (p) => (p === 'apply:done' ? ['none', 'succeeded'] : ['pending', 'failed']),
    required: ['apply'],
  },
  {
    name: 'consent approve and enable',
    setup: async (H) => { await H.run({ type: 'install', source: await H.pack() }); },
    input: () => ({ type: 'consent', modId: ID, approve: true, enable: true }),
    classify: async (H, ops) => ops.state().mods[ID].status,
    expect: (p) => ({ apply: p === 'apply' ? ['pending-consent', 'failed'] : ['disabled', 'succeeded'], compatibility: ['disabled', 'succeeded'], activate: ['disabled', 'needs-attention'], commit: ['enabled', 'succeeded'] })[base(p)],
    required: ['apply', 'compatibility', 'activate', 'commit'],
  },
  {
    name: 'enable',
    setup: async (H) => { await H.installApprove(); },
    input: () => ({ type: 'enable', modId: ID }),
    classify: async (H, ops) => ops.state().mods[ID].status,
    expect: (p) => ({ compatibility: ['disabled', 'failed'], activate: ['disabled', 'needs-attention'], commit: ['enabled', 'succeeded'] })[base(p)],
    required: ['compatibility', 'activate', 'commit'],
  },
  {
    name: 'disable',
    setup: async (H) => { await H.installApprove({}, { enable: true }); },
    input: () => ({ type: 'disable', modId: ID }),
    classify: async (H, ops) => ops.state().mods[ID].status,
    expect: () => ['disabled', 'succeeded'],
    required: ['deactivate', 'commit'],
  },
  {
    // Scoped patches (systems.md E3): the app map and the overrides; recovery by what is stored at each key and scope.
    name: 'configure (patches)',
    setup: async (H) => { await H.installApprove({ settings: [{ key: 'n', kind: 'number', title: 'N', description: 'A number', default: 1, scope: 'project' }] }); },
    input: () => ({ type: 'configure', modId: ID, patches: [{ key: 'n', scope: 'app', value: 5 }, { key: 'n', scope: { project: { provider: 'codex', id: 'p' } }, value: 6 }] }),
    classify: async (H) => {
      const app = JSON.parse((await H.readData(ID, 'settings.json')) ?? '{}');
      const scopes = JSON.parse((await H.readData(ID, 'settings.scopes.json')) ?? '{}');
      return `${app.n ?? '-'}/${scopes['project:codex:p']?.n ?? '-'}`;
    },
    expect: (p) => (p === 'write' ? ['-/-', 'failed'] : ['5/6', 'succeeded']),
    required: ['write'],
  },
  {
    name: 'configure',
    setup: async (H) => { await H.installApprove({ settings: [{ key: 'n', kind: 'number', title: 'N', default: 1 }] }); await H.run({ type: 'configure', modId: ID, patches: [{ key: 'n', scope: 'app', value: 1 }] }); },
    input: () => ({ type: 'configure', modId: ID, patches: [{ key: 'n', scope: 'app', value: 5 }] }),
    classify: async (H) => { const s = JSON.parse(await H.readData(ID, 'settings.json')); assert.ok(s.n === 1 || s.n === 5); return s.n; },
    expect: (p) => (p === 'write' ? [1, 'failed'] : [5, 'succeeded']),
    required: ['write'],
  },
  {
    name: 'clear-quarantine',
    setup: async (H) => { await H.installApprove({}, { enable: true }); await H.ops.quarantine(ID, 'bad'); },
    input: () => ({ type: 'clear-quarantine', modId: ID }),
    classify: async (H, ops) => ops.state().mods[ID].status,
    expect: (p) => (p === 'apply' ? ['quarantined', 'failed'] : ['disabled', 'succeeded']),
    required: ['apply'],
  },
  {
    name: 'reload (stopped)',
    setup: async (H) => { await H.installApprove({}, { enable: true }); await H.ops.quarantine(ID, 'bad'); },
    input: () => ({ type: 'reload', modId: ID }),
    classify: async (H, ops) => ops.state().mods[ID].status,
    expect: (p) => (base(p) === 'commit' ? ['enabled', 'succeeded'] : base(p) === 'activate' ? ['quarantined', 'needs-attention'] : ['quarantined', 'failed']),
    required: ['compatibility', 'stop', 'activate', 'commit'],
  },
  {
    name: 'reload (on)',
    setup: async (H) => { await H.installApprove({}, { enable: true }); },
    input: () => ({ type: 'reload', modId: ID }),
    classify: async (H, ops) => ops.state().mods[ID].status,
    expect: () => ['enabled', 'succeeded'],
    required: ['compatibility', 'stop', 'activate', 'commit'],
  },
  ...[false, true].map((deleteData) => ({
    name: `remove (${deleteData ? 'delete' : 'keep'} data)`,
    setup: async (H) => { await H.installApprove({}, { enable: true }); await H.writeData(ID, 'data-1'); await mkdir(join(H.L.snapshots, ID, '0.9.0'), { recursive: true }); },
    input: () => ({ type: 'remove', modId: ID, deleteData }),
    classify: async (H, ops) => {
      const installed = Boolean(ops.state().mods[ID]);
      const live = await H.readData(ID);
      const orphan = await H.orphanData(ID);
      if (installed) { assert.equal(live, 'data-1'); assert.equal(orphan, undefined); return 'installed'; }
      if (deleteData) { assert.equal(live, undefined); assert.deepEqual(await H.ls(join(H.L.snapshots, ID)), []); return 'removed'; }
      assert.equal(live, undefined); assert.equal(orphan, 'data-1'); return 'removed';
    },
    expect: (p) => (base(p) === 'stop' ? ['installed', 'failed'] : ['removed', 'succeeded']),
    required: deleteData ? ['stop', 'unrecord', 'delete-data'] : ['stop', 'move-data', 'unrecord'],
    extra: async (H, label, point, dead) => {
      if (label === 'removed' && deleteData) assert.ok([...dead.names('deleteSecrets'), ...H.runtime.names('deleteSecrets')].length >= 1);
    },
  })),
  {
    name: 'remove (keep data) when an earlier generation already exists',
    setup: async (H) => {
      await H.installApprove({}, { enable: true }); await H.writeData(ID, 'data-1');
      await H.run({ type: 'remove', modId: ID, deleteData: false });
      await sleep(5);
      await H.installApprove({}, { enable: true }); await H.writeData(ID, 'data-2');
    },
    input: () => ({ type: 'remove', modId: ID, deleteData: false }),
    classify: async (H, ops) => {
      const gens = await H.orphanGens(ID);
      const first = await H.orphanData(ID, gens[0]);
      assert.equal(first, 'data-1', 'the earlier generation is never touched');
      if (ops.state().mods[ID]) { assert.equal(await H.readData(ID), 'data-2'); assert.equal(gens.length, 1); return 'installed'; }
      assert.equal(await H.readData(ID), undefined); assert.equal(gens.length, 2); assert.equal(await H.orphanData(ID, gens[1]), 'data-2');
      assert.ok(await H.orphanData(ID, gens[1], '.orphan.json'), 'provenance written (also after an interrupted move)');
      return 'removed';
    },
    expect: (p) => (base(p) === 'stop' ? ['installed', 'failed'] : ['removed', 'succeeded']),
    required: ['stop', 'move-data', 'unrecord'],
  },
  {
    name: 'reattach with migration',
    setup: async (H) => {
      await H.installApprove({}, { enable: true }); await H.writeData(ID, 'data-1');
      await H.run({ type: 'remove', modId: ID, deleteData: false });
      await H.installApprove({ version: '2.0.0', data: { schemaVersion: 2, migrate: 'migrate.js' } }, { files: MIGRATE });
      H.runtime.migrate = async (o) => { await writeFile(join(o.stagedDataDir, 'store.json'), 'data-2'); };
    },
    input: () => ({ type: 'reattach', modId: ID }),
    classify: async (H, ops) => {
      const data = await H.readData(ID);
      const orphan = await H.orphanData(ID);
      if (data === undefined) { assert.equal(orphan, 'data-1'); assert.equal(ops.state().mods[ID].dataSchemaVersion, 2); return 'orphaned'; }
      assert.equal(data, 'data-2'); assert.equal(orphan, undefined); assert.equal(ops.state().mods[ID].dataSchemaVersion, 2); return 'attached';
    },
    expect: (p) => (['stage', 'migrate'].includes(base(p)) || p === 'attach' ? ['orphaned', 'failed'] : ['attached', 'succeeded']),
    required: ['stage', 'migrate', 'attach', 'finish'],
  },
  {
    // E6: an enabled mod is turned off, reattached and turned on again in one operation; a mod that was on is on again after recovery,
    // except when its activation was interrupted (it may have acted: left off, needs attention)
    name: 'reattach of an enabled mod',
    setup: async (H) => {
      await H.installApprove({}, { enable: true }); await H.writeData(ID, 'data-1');
      await H.run({ type: 'remove', modId: ID, deleteData: false });
      await H.installApprove({}, { enable: true });
    },
    input: () => ({ type: 'reattach', modId: ID }),
    classify: async (H, ops) => {
      const data = await H.readData(ID);
      const orphan = await H.orphanData(ID);
      const status = ops.state().mods[ID].status;
      if (data === undefined) { assert.equal(orphan, 'data-1'); assert.equal(status, 'enabled'); return 'orphaned'; }
      assert.equal(data, 'data-1'); assert.equal(orphan, undefined);
      return status === 'enabled' ? 'attached' : 'attached-off';
    },
    expect: (p) => (['deactivate', 'disable'].includes(base(p)) || p === 'attach' ? ['orphaned', 'failed']
      : base(p) === 'activate' ? ['attached-off', 'needs-attention'] : ['attached', 'succeeded']),
    required: ['deactivate', 'disable', 'attach', 'finish', 'compatibility', 'activate', 'commit'],
  },
];

async function runScenario(scenario, point) {
  const H = await harness({ healthWindowMs: 30 });
  try {
    let armed = false, resolveCrash;
    const crashed = new Promise((r) => { resolveCrash = r; });
    const points = [];
    H.ops = H.create({ crashAt: (n) => { if (!armed) return; points.push(n); if (n === point) { armed = false; resolveCrash(); throw new Error(`injected crash at ${n}`); } } });
    await scenario.setup(H);
    armed = true;
    const opId = await H.ops.start(scenario.input(H));
    if (point === null) { await H.ops.whenSettled(opId); return { points, H, opId }; }
    await crashed;
    await sleep(60);                                  // the dead instance must stay dead
    const dead = H.runtime;
    H.runtime = new FakeRuntime();                    // a new process: nothing is active
    const ops2 = H.create();
    assert.equal(ops2.get(opId).outcome, 'running');
    await ops2.recover();
    const op = ops2.get(opId);
    const [wantLabel, wantOutcome] = scenario.expect(point);
    assert.notEqual(op.outcome, 'running', `${point}: still running`);
    const label = await scenario.classify(H, ops2);
    assert.equal(label, wantLabel, `${point}: state ${label}, op ${op.outcome} ${op.note ?? ''}`);
    assert.equal(op.outcome, wantOutcome, `${point}: outcome (${op.note ?? ''})`);
    assert.deepEqual(H.runtime.names('activate'), [], `${point}: recovery must not run mod activation code`);
    assert.deepEqual(await strays(H), [], `${point}: leftover temporary files`);
    assert.deepEqual(ops2.list({ running: true }), []);
    // state.json on disk is the truth the next boot sees
    const disk = await H.readState().catch(() => undefined);   // absent when nothing was ever recorded
    if (disk) assert.deepEqual(disk, ops2.state());
    else assert.deepEqual(ops2.state().mods, {});
    assert.deepEqual(JSON.parse(await readFile(join(H.L.ops, `${opId}.json`), 'utf8')), op);
    await scenario.extra?.(H, label, point, dead);
    // the next boot works on that state
    await ops2.activateAll();
    const r = ops2.state().mods[ID];
    if (r?.status === 'enabled') assert.deepEqual(H.runtime.names('activate'), [[ID, r.version]]);
    return { points };
  } finally { await H.cleanup(); }
}

for (const scenario of scenarios) {
  test(`crash injection: ${scenario.name}`, async () => {
    const { points } = await runScenario(scenario, null);
    for (const need of scenario.required) assert.ok(points.includes(need), `scenario never reaches phase ${need} (saw ${points})`);
    assert.ok(points.length >= scenario.required.length * 2, 'every phase has a before and an after crash point');
    for (const point of points) await runScenario(scenario, point);
  });
}

test('recover(): framework ops go through Recovery.reconcileOp first; a non-null result is applied, null leaves the op running', async () => {
  const H = await harness();
  try {
    await H.installApprove({}, { enable: true });
    H.recovery.runOpImpl = async () => ({ outcome: 'running', note: 'awaiting swap receipt' });
    const a = await H.ops.start({ type: 'app-switch', candidate: '/x/y.app' });
    await H.recorded(H.ops, a, 'awaiting swap receipt');
    assert.equal(H.ops.get(a).outcome, 'running');
    // a mod op left running as well
    const order = [];
    const ops2 = H.create();
    H.recovery.reconcileImpl = async (op) => { order.push(`reconcile:${op.input.type}`); return { outcome: 'succeeded', note: 'swap done', result: { ok: true } }; };
    const origRecover = H.recovery.reconcileOp.bind(H.recovery);
    await ops2.recover();
    const rec = ops2.get(a);
    assert.equal(rec.outcome, 'succeeded');
    assert.equal(rec.note, 'swap done');
    assert.deepEqual(rec.result, { ok: true });
    assert.ok(rec.endedAt);
    assert.deepEqual(order, ['reconcile:app-switch']);
    // null → stays running and keeps the framework lock
    H.recovery.runOpImpl = async () => ({ outcome: 'running', note: 'still waiting' });
    const b = await ops2.start({ type: 'app-switch', candidate: '/x/z.app' });
    await H.recorded(ops2, b, 'still waiting');
    H.recovery.reconcileImpl = async () => null;
    const ops3 = H.create();
    await ops3.recover();
    assert.equal(ops3.get(b).outcome, 'running');
    await assert.rejects(ops3.start({ type: 'safe-mode', enter: true }), (e) => e.code === 'Conflict');
    void origRecover;
  } finally { await H.cleanup(); }
});

test('recover(): all framework ops are reconciled before any mod op is replayed', async () => {
  const H = await harness();
  try {
    await H.installApprove({}, { enable: true });
    H.recovery.runOpImpl = async () => ({ outcome: 'running', note: 'prepared' });
    // a framework op started AFTER the mod op, so a naive start-time ordering would replay the mod op first
    const { crashAt, crashed } = H.crashAt('deactivate');
    H.ops = H.create({ crashAt });
    const modOp = await H.ops.start({ type: 'disable', modId: ID });
    await crashed;
    await sleep(20);
    const ops1 = H.create();           // a surviving instance cannot be used (dead); start the framework op from a clean one
    const fwOp = await ops1.start({ type: 'app-prepare' });
    await H.recorded(ops1, fwOp, 'prepared');
    H.runtime = new FakeRuntime();
    H.recovery.reconcileImpl = async () => ({ outcome: 'failed', note: 'not done' });
    const ops2 = H.create();
    const seen = [];
    ops2.subscribe((o) => { if (o.outcome !== 'running') seen.push(o.id); });
    await ops2.recover();
    assert.deepEqual(seen, [fwOp, modOp]);
    assert.equal(ops2.get(fwOp).outcome, 'failed');
    assert.equal(ops2.get(modOp).outcome, 'succeeded');
  } finally { await H.cleanup(); }
});
