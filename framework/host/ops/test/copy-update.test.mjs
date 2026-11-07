// The copy's update as one operation (docs/design/systems.md S20, "E5 in detail"): real Operations and real Recovery on one fixture root,
// a fake swap helper, the loader's revert as loader.cjs does it, and a boot sequence (early reconcile, beginBoot, recover, health). Each
// scenario is run with a crash at every journaled phase, before and after its effects, and recovered by a fresh process: it must end in one
// coherent generation, all old or all new, with the expected outcome; after the switch, the verdict waits for the new build's health.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, symlink, rm, readlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harness, FakeRuntime } from './harness.mjs';
import { createRecovery } from '../../recovery/index.mjs';
import { frameworkTreeHash } from '../../recovery/support.mjs';
import { planHashOf, planFile } from '../../updates/plan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const ADAPTER = { adapterVersion: '1.0.0', build: { version: '27.0', bundleVersion: '100' }, protocol: { methods: { clientRequests: ['thread/start'] } } };
const APP = 'ChatGPT Mods.app';
const OLD = '1.0.0', NEW = '1.1.0';   // framework versions (the mods' range is >=1 <2)
const sha256 = async (f) => createHash('sha256').update(await readFile(f)).digest('hex');
const tick = () => new Promise((r) => setTimeout(r, 5));

/** The loader's revert after two unhealthy boots (loader/loader.cjs §4): framework current to last-known-good, the symlink to lkg-app. */
async function loaderRevert(H) {
  const L = H.L;
  const lkg = (await readFile(L.frameworkLkg, 'utf8').catch(() => '')).trim();
  const cur = (await readFile(L.frameworkCurrent, 'utf8').catch(() => '')).trim();
  if (lkg && lkg !== cur) await writeFile(L.frameworkCurrent, `${lkg}\n`);
  const lkgApp = (await readFile(L.lkgApp, 'utf8').catch(() => '')).trim();
  const profile = JSON.parse(await readFile(L.profileConfig, 'utf8'));
  if (lkgApp) { await rm(profile.appPath, { force: true }); await symlink(lkgApp, profile.appPath); }
  return lkgApp;
}

/** A fixture: two copies, two framework trees (the new one staged), two mods (one migrates, one is held and left behind), the plan. */
async function fixture({ framework = true, migrate = true, held = true, alpha = {}, incoming = {}, github = null } = {}) {
  const H = await harness();
  const L = H.L;
  const oldApp = join(L.apps, '27.0-100-old', APP), newApp = join(L.apps, '27.1-101-new', APP);
  for (const d of [oldApp, newApp]) await mkdir(d, { recursive: true });
  await writeFile(join(dirname(newApp), 'build-report.json'), JSON.stringify({ inputsHash: 'IH-new' }));
  const appPath = join(L.root, 'Mods.app');
  await symlink(oldApp, appPath);
  await mkdir(L.profileDir, { recursive: true });
  await writeFile(L.profileConfig, JSON.stringify({ codexHome: L.codexHome, guardStockApp: false, signingIdentity: '-', appPath, launchArgs: [] }));
  for (const v of [OLD]) await mkdir(join(L.framework, v, 'framework', 'main'), { recursive: true }).then(() => writeFile(join(L.framework, v, 'framework', 'main', 'index.cjs'), `// ${v}`));
  await writeFile(L.frameworkCurrent, `${OLD}\n`); await writeFile(L.frameworkLkg, `${OLD}\n`);
  await writeFile(L.lkgApp, oldApp);
  const staged = join(L.updates, 'framework', NEW);
  await mkdir(join(staged, 'framework', 'main'), { recursive: true });
  await writeFile(join(staged, 'framework', 'main', 'index.cjs'), '// new');
  const treeHash = await frameworkTreeHash(staged);
  // mods: alpha migrates 1 -> 2, beta is at risk on the new build
  H.runtime.migrate = async (o) => { await writeFile(join(o.stagedDataDir, 'store.json'), JSON.stringify({ schema: o.to })); };
  await H.installApprove({ id: 'test.alpha', data: { schemaVersion: 1 }, ...alpha }, { enable: true });
  for (const g of alpha.optionalPermissions ?? []) await H.run({ type: 'set-permission', modId: 'test.alpha', grant: g, decision: 'allow' });
  await H.writeData('test.alpha', JSON.stringify({ schema: 1 }));
  await H.installApprove({ id: 'test.beta' }, { enable: true });
  const pkg = await H.pack({ id: 'test.alpha', version: '2.0.0', data: migrate ? { schemaVersion: 2, migrate: 'migrate.mjs' } : { schemaVersion: 1 }, ...incoming }, { 'migrate.mjs': 'export default async () => {}' });
  const plan = {
    plan: 1, createdAt: 'x', candidate: { path: newApp, inputsHash: 'IH-new' },
    framework: framework ? { from: OLD, to: NEW, treeHash, dir: staged } : null,
    enabled: [
      { id: 'test.alpha', version: '1.0.0', current: { status: 'compatible', reasons: [] },
        incoming: { version: '2.0.0', package: pkg, sha256: await sha256(pkg), addedPermissions: [], status: 'compatible', reasons: [], ...(github ? { github } : {}) } },
      { id: 'test.beta', version: '1.0.0', current: held ? { status: 'atRisk', reasons: [{ id: 'exposure:Select', required: true, status: 'unknown', sentence: 'It needs the Select.' }] } : { status: 'compatible', reasons: [] } },
    ],
  };
  plan.hash = planHashOf(plan);
  await mkdir(dirname(planFile(L, plan.hash)), { recursive: true });
  await writeFile(planFile(L, plan.hash), JSON.stringify(plan));
  return { H, L, oldApp, newApp, appPath, plan, staged };
}

/** One process: a Recovery and an Operations on the fixture's root, the running copy as given, the swap helper faked. */
function processOf(f, { running, crashAt, helper }) {
  let ops;
  const bus = f.H.bus;
  const spawned = [];
  const rec = createRecovery({
    layout: f.L, log: f.H.log, bus, operationsState: () => ops.state(), operations: () => ops, requestExit: () => {},
    appBuild: '27.0-100', frameworkVersion: (readFileSync(f.L.frameworkCurrent, 'utf8').trim()), adapterVersion: '1.0.0', adapter: ADAPTER,
    runningAppPath: running, activeMods: () => [...f.H.runtime.active],
    deps: {
      spawn: (cmd, args) => { spawned.push(args); helper?.(args); const e = new EventEmitter(); setImmediate(() => e.emit('spawn')); e.unref = () => {}; return e; },
      appPid: () => 1, exitDelayMs: 0, exitGraceMs: 0, healthWindowMs: 60_000, healthTickMs: 5,
    },
  });
  f.H.runtime = new FakeRuntime();
  f.H.runtime.migrate = async (o) => { await writeFile(join(o.stagedDataDir, 'store.json'), JSON.stringify({ schema: o.to })); };
  ops = f.H.create({ recovery: rec, ...(crashAt ? { crashAt } : {}), swapWaitTicks: 2, swapWaitMs: 1 });
  return { rec, ops, spawned };
}

/** The swap helper's work, done when the old app has quit: repoint and receipt (`ok`), or the receipt of a failure. */
async function helperDone(f, args, ok = true) {
  const [, , stable, candidate, receipt] = args;
  const previous = resolve(dirname(stable), await readlink(stable));
  if (ok) { await rm(stable, { force: true }); await symlink(candidate, stable); }
  await mkdir(dirname(receipt), { recursive: true });
  await writeFile(receipt, JSON.stringify({ ok, previous, candidate, ...(ok ? {} : { error: 'open failed' }) }));
}

/** A boot: the early reconcile, beginBoot, recover, the mods activated, and (when `healthy`) the health gate passed. */
async function boot(f, { running, healthy = true, crashAt } = {}) {
  const p = processOf(f, { running, crashAt });
  await p.ops.recoverEarly();
  await p.rec.beginBoot();
  await p.ops.recover();
  await p.ops.activateAll();
  if (healthy) {
    p.rec.report('window-rendered'); p.rec.report('host-ready'); f.H.bus.publish('appServer/ready', {}, { state: true });
    await p.rec.idle();
    await p.ops.reconcileFramework();
  }
  return p;
}

/** Old or new, from every piece of the copy's state; mixed is a failure of the operation. */
async function sideOf(f) {
  const st = JSON.parse(await readFile(f.L.state, 'utf8'));
  const a = st.mods['test.alpha'], b = st.mods['test.beta'];
  const pieces = {
    framework: (await readFile(f.L.frameworkCurrent, 'utf8')).trim() === NEW ? 'new' : 'old',
    app: resolve(dirname(f.appPath), await readlink(f.appPath)) === f.newApp ? 'new' : 'old',
    alpha: a.version === '2.0.0' ? 'new' : 'old',
    alphaData: JSON.parse(await f.H.readData('test.alpha')).schema === (f.plan.enabled[0].incoming && f.migrate !== false ? 2 : 1) && a.version === '2.0.0' ? 'new' : JSON.parse(await f.H.readData('test.alpha')).schema === 1 ? 'old' : 'mixed',
    beta: b.status === 'disabled' && b.leftBehind ? 'new' : b.status === 'enabled' && !b.leftBehind ? 'old' : 'mixed',
  };
  if (!f.plan.framework) delete pieces.framework;
  const sides = new Set(Object.values(pieces));
  return { side: sides.size === 1 ? [...sides][0] : 'mixed', pieces };
}

/** Until the op ends, switches, or the process crashed (the crash hook says so: never a guess from time). */
async function settle(ops, id, crashed = () => false) {
  for (let i = 0; i < 6000; i++) {
    const op = ops.get(id);
    if (!op || op.outcome !== 'running' || /^switching/.test(op.note ?? '') || crashed()) { await tick(); return ops.get(id); }
    await tick();
  }
  return ops.get(id);
}

/** Runs the update once; `crash` the phase to die at; answers the op, the process and whether the helper was started. */
async function apply(f, { crash = null, anyway = true, consent, names } = {}) {
  let helperArgs = null, crashed = false;
  const crashAt = crash || names ? async (n) => { names?.push(n); if (n === crash) { crashed = true; throw new Error('crash'); } } : undefined;
  const p = processOf(f, { running: f.oldApp, crashAt, helper: (args) => { helperArgs = args; } });
  await p.ops.recover();
  for (const id of ['test.alpha', 'test.beta']) f.H.runtime.active.add(id);
  const id = await p.ops.start({ type: 'copy-update', plan: f.plan.hash, ...(anyway ? { anyway: true } : {}), ...(consent ? { consent } : {}) });
  const op = await settle(p.ops, id, () => crashed);
  return { id, op, p, helperArgs };
}

test('a full update: app, framework and a migrating mod in one generation, the held mod left behind, succeeded once healthy', async () => {
  const f = await fixture();
  try {
    const { id, op, helperArgs } = await apply(f);
    assert.equal(op.outcome, 'running', JSON.stringify({ note: op.note, error: op.error, phases: op.phases.map((x) => x.name) }));
    assert.deepEqual(op.phases.map((x) => x.name), ['recheck', 'leave:test.beta', 'mod-verify:test.alpha', 'mod-commit:test.alpha:stop', 'mod-commit:test.alpha:snapshot',
      'mod-commit:test.alpha:migrate', 'mod-commit:test.alpha:swap', 'mod-commit:test.alpha:apply', 'framework-install', 'framework-pointers:previous', 'framework-pointers:current', 'swapping']);
    assert.ok(helperArgs, 'the swap helper was started');
    await helperDone(f, helperArgs, true);
    const p = await boot(f, { running: f.newApp });
    const done = p.ops.get(id);
    assert.equal(done.outcome, 'succeeded', done.note);
    assert.deepEqual((await sideOf(f)).side, 'new');
    assert.equal((await readFile(f.L.frameworkLkg, 'utf8')).trim(), NEW, 'last-known-good moved with the healthy boot');
    assert.equal((await readFile(f.L.lkgApp, 'utf8')).trim(), f.newApp);
    const st = JSON.parse(await readFile(f.L.state, 'utf8'));
    assert.match(st.mods['test.beta'].leftBehind.why[0], /It needs the Select/);
  } finally { await f.H.cleanup(); }
});

test('held without anyway: refused at the recheck, nothing applied; a stale plan is refused the same way', async () => {
  const f = await fixture();
  try {
    const { op } = await apply(f, { anyway: false });
    assert.equal(op.outcome, 'failed');
    assert.match(op.note, /the update is held: test\.beta: It needs the Select/);
    assert.equal((await sideOf(f)).side, 'old');
    await writeFile(join(dirname(f.newApp), 'build-report.json'), JSON.stringify({ inputsHash: 'other' }));
    const again = await apply(f);
    assert.equal(again.op.outcome, 'failed');
    assert.match(again.op.note, /stale: its candidate copy was built from other inputs/);
  } finally { await f.H.cleanup(); }
});

test('a crash at every phase before the switch recovers to the old generation, the update failed; after it, the helper and health decide', async () => {
  const names = [];
  { const f = await fixture(); try { await apply(f, { names }); } finally { await f.H.cleanup(); } }
  assert.ok(names.includes('recheck') && names.includes('swapping:done') && names.includes('framework-pointers:current:done') && names.includes('mod-commit:test.alpha:swap:done'));
  for (const crash of names) {
    const f = await fixture();
    try {
      const { id, helperArgs } = await apply(f, { crash });
      const switchedAndSpawned = crash === 'swapping:done';
      if (switchedAndSpawned) await helperDone(f, helperArgs, true);
      const p = await boot(f, { running: switchedAndSpawned ? f.newApp : f.oldApp });
      const op = p.ops.get(id);
      const { side, pieces } = await sideOf(f);
      if (switchedAndSpawned) {
        assert.deepEqual([op.outcome, side], ['succeeded', 'new'], `${crash}: ${JSON.stringify(pieces)} ${op.note}`);
      } else if (crash === 'swapping') {
        // journaled, the helper never started: the boot runs the old copy with no receipt: undone
        assert.deepEqual([op.outcome, side], ['failed', 'old'], `${crash}: ${JSON.stringify(pieces)} ${op.note}`);
      } else {
        assert.deepEqual([op.outcome, side], ['failed', 'old'], `${crash}: ${JSON.stringify(pieces)} ${op.note}`);
      }
      assert.equal(p.ops.list({ running: true }).length, 0, `${crash}: nothing left running`);
      assert.deepEqual(f.H.runtime.names('activate').filter((a) => a[0] === 'test.beta' && side === 'new'), [], `${crash}: a mod left behind never runs`);
      // recovering again changes nothing
      const before = await readFile(f.L.state, 'utf8');
      await boot(f, { running: switchedAndSpawned ? f.newApp : f.oldApp });
      assert.equal(await readFile(f.L.state, 'utf8').then((s) => JSON.stringify(JSON.parse(s).mods)), JSON.stringify(JSON.parse(before).mods), `${crash}: idempotent`);
    } finally { await f.H.cleanup(); }
  }
});

test('a crash during the undo of a crashed update finishes the undo at the next boot', async () => {
  const f = await fixture();
  try {
    const { id } = await apply(f, { crash: 'framework-pointers:current:done' });
    const undoNames = [];
    let first = true;
    const crashAt = async (n) => { undoNames.push(n); if (first && n === 'undo:mod:test.alpha') { first = false; throw new Error('crash'); } };
    const p1 = processOf(f, { running: f.oldApp, crashAt });
    await p1.ops.recoverEarly().catch(() => {});
    assert.ok(undoNames.includes('undo:framework-pointers'));
    const p2 = await boot(f, { running: f.oldApp });
    assert.equal(p2.ops.get(id).outcome, 'failed');
    assert.equal((await sideOf(f)).side, 'old');
  } finally { await f.H.cleanup(); }
});

test('after the switch: the helper failing undoes everything; the loader\'s revert after unhealthy boots restores the mods, the left one stays off', async () => {
  {
    const f = await fixture();
    try {
      const { id, helperArgs } = await apply(f);
      await helperDone(f, helperArgs, false);
      const p = await boot(f, { running: f.oldApp });
      assert.equal(p.ops.get(id).outcome, 'failed');
      assert.match(p.ops.get(id).note, /The switch did not happen/);
      assert.equal((await sideOf(f)).side, 'old');
    } finally { await f.H.cleanup(); }
  }
  {
    const f = await fixture();
    try {
      const { id, helperArgs } = await apply(f);
      await helperDone(f, helperArgs, true);
      const p1 = await boot(f, { running: f.newApp, healthy: false });
      assert.equal(p1.ops.get(id).outcome, 'running', 'waiting for its verdict');
      // a mod the update changed refuses what would change it under the update
      await assert.rejects(p1.ops.start({ type: 'remove', modId: 'test.alpha', deleteData: false }), /part of the update/);
      await boot(f, { running: f.newApp, healthy: false });
      const lkgApp = await loaderRevert(f.H);
      const p3 = await boot(f, { running: lkgApp });
      const op = p3.ops.get(id);
      assert.equal(op.outcome, 'reverted', op.note);
      const st = JSON.parse(await readFile(f.L.state, 'utf8'));
      assert.equal(st.mods['test.alpha'].version, '1.0.0');
      assert.equal(JSON.parse(await f.H.readData('test.alpha')).schema, 1, 'its data from the snapshot');
      assert.equal(st.mods['test.beta'].status, 'disabled', 'left behind: stays off and says why');
      assert.ok(st.mods['test.beta'].leftBehind);
      assert.equal((await readFile(f.L.frameworkCurrent, 'utf8')).trim(), OLD);
    } finally { await f.H.cleanup(); }
  }
});

test('pending its verdict: safe mode does not wait for it, restoring last-known-good concludes it as reverted first', async () => {
  const f = await fixture();
  try {
    const { id, helperArgs } = await apply(f);
    await helperDone(f, helperArgs, true);
    const p = await boot(f, { running: f.newApp, healthy: false });
    assert.equal(p.ops.get(id).outcome, 'running');
    const safe = await p.ops.start({ type: 'safe-mode', enter: true });
    assert.ok(safe, 'safe mode starts while the update waits');
    await p.ops.whenSettled?.(safe);
    const p2 = processOf(f, { running: f.newApp });
    await p2.ops.recoverEarly();
    await p2.rec.beginBoot();
    await p2.ops.recover();
    // last-known-good is the old generation (the new one never became healthy): restoring it reverts the update first
    await p2.ops.start({ type: 'lkg-restore' }).catch(() => {});
    assert.equal(p2.ops.get(id).outcome, 'reverted');
    assert.match(p2.ops.get(id).note, /Last known good was restored/);
    assert.equal(JSON.parse(await readFile(f.L.state, 'utf8')).mods['test.alpha'].version, '1.0.0');
  } finally { await f.H.cleanup(); }
});

test('F8: what an incoming mod requires beyond what it holds as required is read again under the lock: an optional permission become required needs consent, whatever its decision (FU5/FU6 review)', async () => {
  const f = await fixture({ held: false, alpha: { optionalPermissions: ['secrets'] }, incoming: { permissions: ['secrets'] } });
  try {
    assert.deepEqual(f.H.ops.state().mods['test.alpha'].decisions, { secrets: 'allow' });
    const { op } = await apply(f);
    assert.equal(op.outcome, 'failed', op.note);
    assert.match(op.note, /test\.alpha 2\.0\.0 requires secrets, which you have not approved/);
    const st = JSON.parse(await readFile(f.L.state, 'utf8'));
    assert.deepEqual([st.mods['test.alpha'].version, st.mods['test.alpha'].decisions], ['1.0.0', { secrets: 'allow' }], 'nothing applied');
  } finally { await f.H.cleanup(); }
});

test('F8: an update undone keeps a decision you lowered while it waited for its first healthy boot (FU5/FU6 review)', async () => {
  const f = await fixture({ held: false, alpha: { optionalPermissions: ['secrets'] }, incoming: { optionalPermissions: ['secrets'] } });
  try {
    const { id, helperArgs } = await apply(f);
    await helperDone(f, helperArgs, true);
    const p1 = await boot(f, { running: f.newApp, healthy: false });
    assert.equal(p1.ops.get(id).outcome, 'running', 'waiting for its verdict');
    const deny = await p1.ops.start({ type: 'set-permission', modId: 'test.alpha', grant: 'secrets', decision: 'deny' });
    assert.equal((await p1.ops.whenSettled(deny)).outcome, 'succeeded');
    await boot(f, { running: f.newApp, healthy: false });
    const lkgApp = await loaderRevert(f.H);
    const p3 = await boot(f, { running: lkgApp });
    assert.equal(p3.ops.get(id).outcome, 'reverted');
    const a = JSON.parse(await readFile(f.L.state, 'utf8')).mods['test.alpha'];
    assert.deepEqual([a.version, a.decisions, a.grants.includes('secrets')], ['1.0.0', { secrets: 'deny' }, false], 'the deny stays');
  } finally { await f.H.cleanup(); }
});

test('F11: a mod\'s GitHub release applied with the copy is where it comes from now; its package is the bytes staging checked', async () => {
  const github = { repo: 'acme/alpha', repoId: 9, tag: 'v2.0.0', digest: 'sha256:unused-here' };
  const f = await fixture({ held: false, github });
  try {
    const { op } = await apply(f);
    assert.match(op.note ?? '', /^switching/, JSON.stringify(op));
    const a = JSON.parse(await readFile(f.L.state, 'utf8')).mods['test.alpha'];
    assert.deepEqual([a.version, a.source], ['2.0.0', { kind: 'github', repo: 'acme/alpha', repoId: 9, tag: 'v2.0.0', digest: 'sha256:unused-here' }]);
  } finally { await f.H.cleanup(); }
  const g = await fixture({ held: false });
  try {
    await writeFile(g.plan.enabled[0].incoming.package, 'not what staging checked');
    const { op } = await apply(g);
    assert.equal(op.outcome, 'failed');
    assert.match(op.note, /the package of test\.alpha 2\.0\.0 changed/, 'refused at the recheck; between it and the check of the package, by its digest');
  } finally { await g.H.cleanup(); }
});

test('the loader\'s revert this harness mirrors is what loader.cjs does', () => {
  const src = readFileSync(join(ROOT, 'loader', 'loader.cjs'), 'utf8');
  for (const s of ['if (unhealthy >= 2) {', 'writeAtomic(L.frameworkCurrent, lkgVersion + \'\\n\');', 'fs.symlinkSync(lkgApp, tmpLink);', 'fs.renameSync(tmpLink, appPath);']) {
    assert.ok(src.includes(s), `loader.cjs still: ${s}`);
  }
});
