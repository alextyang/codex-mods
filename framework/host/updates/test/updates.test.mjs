// An update's release source, staging and detector (docs/design/systems.md S19, S20, "E5 in detail"): a release tree accepted only when
// it is what its release.json says (no symlink, its tree hash, its version, its tools); the newest release of a directory; staging an
// offer into a plan (a snapshot of the stock app, the pack, the candidate built from the snapshot by the framework's builder with the
// copy's flags and reused only for the same inputs, each enabled mod's compatibility, the verdict); a build that cannot be made is a
// problem, not a plan; the detector's offer, its attempts and its dismissals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, symlink, cp, rm, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { layout as layoutOf } from '../../../../contracts/layout.mjs';
import { frameworkTreeHash } from '../../recovery/support.mjs';
import { verifyReleaseTree, createReleaseSource, versionNameOf, isNewer, supportsBuild } from '../release.mjs';
import { createStaging, pruneOlder } from '../staging.mjs';
import { createDetector, createUpdateState } from '../detector.mjs';
import { readPlan, choose, verdictOf, planHashOf } from '../plan.mjs';
import { makeApp, makeFrameworkTree, fakeBuildReport } from '../../recovery/test/helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const tmp = async () => { const d = await mkdtemp(join(tmpdir(), 'cm-updates-')); return { d, done: () => rm(d, { recursive: true, force: true }) }; };

/** A release tree: the framework's tools, its package.json and its release.json with its own tree hash. */
async function releaseTree(dir, version, { mods = [] } = {}) {
  await makeFrameworkTree(dir, { version });
  await mkdir(join(dir, 'framework', 'host'), { recursive: true });
  await writeFile(join(dir, 'framework', 'host', 'main.mjs'), '// host\n');
  await mkdir(join(dir, 'builder'), { recursive: true });
  await writeFile(join(dir, 'builder', 'build.mjs'), '// builder\n');
  const treeHash = await frameworkTreeHash(dir);
  await writeFile(join(dir, 'release.json'), JSON.stringify({ version, treeHash, mods }));
  return treeHash;
}

test('a release tree is accepted only when it is what its release.json says', async () => {
  const t = await tmp();
  try {
    const dir = join(t.d, 'r1');
    await releaseTree(dir, '1.2.0');
    assert.equal((await verifyReleaseTree(dir)).version, '1.2.0');
    await writeFile(join(dir, 'framework', 'main', 'index.cjs'), '// changed');
    await assert.rejects(verifyReleaseTree(dir), /does not match its release\.json/);
    const d2 = join(t.d, 'r2'); await releaseTree(d2, '1.2.0'); await symlink('/etc/hosts', join(d2, 'framework', 'link'));
    await assert.rejects(verifyReleaseTree(d2), /has a symlink/);
    const d3 = join(t.d, 'r3'); await releaseTree(d3, '1.2.0'); await writeFile(join(d3, 'release.json'), JSON.stringify({ version: '1.3.0', treeHash: (JSON.parse(await readFile(join(d3, 'release.json'), 'utf8'))).treeHash }));
    await assert.rejects(verifyReleaseTree(d3), /its package\.json 1\.2\.0/);
    const d4 = join(t.d, 'r4'); await releaseTree(d4, '1.2.0'); await rm(join(d4, 'relay', 'relay'));
    await assert.rejects(verifyReleaseTree(d4), /lacks relay\/relay/);
  } finally { await t.done(); }
});

test('a directory of releases: the newest; versions named by their tree; newer than the running one, a development framework only when asked', async () => {
  const t = await tmp();
  try {
    await releaseTree(join(t.d, 'a'), '1.1.0'); const h = await releaseTree(join(t.d, 'b'), '1.3.0'); await mkdir(join(t.d, 'junk'));
    const src = createReleaseSource({ kind: 'dir', path: t.d }, { updates: join(t.d, 'u') });
    const latest = await src.latest();
    assert.equal(latest.version, '1.3.0');
    const f = await src.fetch(latest);
    assert.equal(versionNameOf(f.release), `1.3.0+${h.slice(0, 8)}`);
    assert.equal(isNewer(latest, '1.2.0+abcd1234'), true);
    assert.equal(isNewer(latest, '1.3.0+abcd1234'), false);
    assert.equal(isNewer(latest, '1.0.0-dev+abcd1234'), false, 'a development framework is not offered on its own');
    assert.equal(isNewer(latest, '1.0.0-dev+abcd1234', { userAsked: true }), true);
    await assert.rejects(createReleaseSource({ kind: 'dir', path: join(t.d, 'nowhere') }, {}).latest(), (e) => e.details?.unknown === true, 'unreachable is unknown');
  } finally { await t.done(); }
});

/** A root with a stock app, the running framework, a pack for the new build and two enabled mods (one at risk). */
async function stagingFixture(t, { packFor = '27.1-101', packages = {}, modOffers, onStep, slowBuilder = null } = {}) {
  const L = layoutOf(join(t.d, 'root'));
  await mkdir(L.profileDir, { recursive: true });
  await writeFile(L.profileConfig, JSON.stringify({ signingIdentity: '-', appPath: join(L.root, 'Mods.app'), launchArgs: [] }));
  const stock = join(t.d, 'Stock.app');
  await makeApp(stock, '27.1', '101');
  await mkdir(join(stock, 'Contents', 'Resources'), { recursive: true });
  await writeFile(join(stock, 'Contents', 'Resources', 'app.asar'), 'asar-bytes');
  const fwDir = join(L.framework, '1.0.0');
  await makeFrameworkTree(fwDir, { version: '1.0.0' });
  if (packFor) {
    await mkdir(join(L.adapters, packFor), { recursive: true });
    await cp(join(ROOT, 'adapters', '26.1016.62342-21477', 'adapter.json'), join(L.adapters, packFor, 'adapter.json'));
    const pack = JSON.parse(await readFile(join(L.adapters, packFor, 'adapter.json'), 'utf8'));
    pack.build = { ...pack.build, version: '27.1', bundleVersion: '101' };
    await writeFile(join(L.adapters, packFor, 'adapter.json'), JSON.stringify(pack));
  }
  const builds = [];
  const runBuilder = async (args) => {
    builds.push(args);
    if (slowBuilder) await slowBuilder();
    const out = args[args.indexOf('--out') + 1];
    await mkdir(join(out, 'ChatGPT Mods.app', 'Contents'), { recursive: true });
    const report = await fakeBuildReport(args, out.split('-').at(-1));
    report.stock.asarSha256 = (await import('node:crypto')).createHash('sha256').update(await readFile(join(args[args.indexOf('--stock') + 1], 'Contents', 'Resources', 'app.asar'))).digest('hex');
    await writeFile(join(out, 'build-report.json'), JSON.stringify(report));
  };
  const mods = {
    'acme.ok': { id: 'acme.ok', version: '1.0.0', status: 'enabled', grants: [], publisher: 'p', source: { kind: 'github', repo: 'acme/ok', repoId: 7, tag: 'v1.0.0', digest: 'sha256:x' } },
    'acme.risky': { id: 'acme.risky', version: '1.0.0', status: 'enabled', grants: [], publisher: 'p' },
    'acme.off': { id: 'acme.off', version: '1.0.0', status: 'disabled', grants: [], publisher: 'p' },
  };
  const manifests = { 'acme.ok': { id: 'acme.ok' }, 'acme.risky': { id: 'acme.risky', requires: { features: ['exposure:Select'] } }, 'acme.off': { id: 'acme.off' } };
  const recovery = { update: { tools: () => ({ stockApp: stock, runBuilder, refreshAdapter: async () => { const e = new Error('mandatory edit cua-bundle-id cannot be derived'); e.code = 'Incompatible'; throw e; },
    inUse: async () => false, runningCopy: null, frameworkDir: fwDir, copyBuild: '27.0-100' }) } };
  const staging = createStaging({ layout: L, frameworkVersion: '1.0.0', adapter: { build: { version: '27.0', bundleVersion: '100' } }, recovery, packages, modOffers, onStep,
    operations: () => ({ state: () => ({ mods }), installed: (id) => ({ manifest: manifests[id] }), compatibility: (m) => ({ status: m.id === 'acme.off' ? 'blocked' : 'compatible' }) }), runBuilder,
    clone: async (src, dst) => { await cp(src, dst, { recursive: true }); } });
  return { L, stock, staging, builds, mods };
}

test('staging: an offer becomes a plan from a snapshot, the candidate built by the framework\'s builder, each enabled mod judged; held when one is at risk', async () => {
  const t = await tmp();
  try {
    const f = await stagingFixture(t);
    const r = await f.staging.stage({ id: '27.1-101|-', stock: { app: f.stock, build: '27.1-101' } });
    assert.ok(r.plan, JSON.stringify(r));
    const plan = await readPlan(f.L, r.plan.hash);
    assert.equal(plan.stock.build, '27.1-101');
    assert.match(plan.stock.snapshot, /updates\/stock\/27\.1-101-[0-9a-f]{12}\/Stock\.app$/, 'built from the snapshot, not the live bundle');
    assert.equal(f.builds[0][f.builds[0].indexOf('--stock') + 1], plan.stock.snapshot);
    assert.equal(plan.pack.from, 'root');
    assert.deepEqual(plan.enabled.map((m) => [m.id, m.current.status]), [['acme.ok', 'compatible'], ['acme.risky', 'atRisk']], 'the disabled mod is not judged');
    const v = verdictOf(choose(plan));
    assert.equal(v.held, true);
    assert.equal(v.risks[0].mod, 'acme.risky');
    // the same inputs again: the same plan, the candidate reused; another stock content: rebuilt
    const again = await f.staging.stage({ id: '27.1-101|-', stock: { app: f.stock, build: '27.1-101' } });
    assert.equal(again.plan.hash, r.plan.hash);
    assert.equal(f.builds.length, 1, 'reused');
    await writeFile(join(f.stock, 'Contents', 'Resources', 'app.asar'), 'other-bytes');
    const changed = await f.staging.stage({ id: '27.1-101|-', stock: { app: f.stock, build: '27.1-101' } });
    assert.notEqual(changed.plan.hash, r.plan.hash);
    assert.equal(f.builds.length, 2, 'the same build id with other content is built again');
    // the newer plan complete: what the older one held goes (its plan, its snapshot); the candidate both name (rebuilt in place) stays
    const gone = async (p) => !(await stat(p).then(() => true, () => false));
    assert.ok(await gone(join(f.L.profileUpdates, r.plan.hash)), 'the older plan');
    assert.ok(await gone(dirname(plan.stock.snapshot)), 'its snapshot');
    assert.ok(!(await gone(dirname(changed.plan.stock.snapshot))) && !(await gone(dirname(changed.plan.candidate.path))));
  } finally { await t.done(); }
});

test('staging: a complete plan removes what older plans held: plans, snapshots, staged trees, candidates the copy does not use', async () => {
  const t = await tmp();
  try {
    const L = layoutOf(join(t.d, 'root'));
    const made = async (...p) => { await mkdir(join(...p), { recursive: true }); return join(...p); };
    const exists = (p) => stat(p).then(() => true, () => false);
    const plan = (hash, stockDir, app, fw) => ({ hash, stock: { snapshot: join(L.updates, 'stock', stockDir, 'Stock.app') }, candidate: { path: join(L.apps, app, 'ChatGPT Mods.app') },
      framework: fw ? { dir: join(L.updates, 'framework', fw) } : null });
    const old = [plan('a'.repeat(32), 's1', 'c1', 'f1'), plan('b'.repeat(32), 's2', 'c2', null)];
    for (const p of old) {
      await writeFile(join(await made(L.profileUpdates, p.hash), 'plan.json'), JSON.stringify(p));
      await made(dirname(p.stock.snapshot)); await made(p.candidate.path); if (p.framework) await made(p.framework.dir);
    }
    const now = plan('c'.repeat(32), 's3', 'c3', 'f3');
    await writeFile(join(await made(L.profileUpdates, now.hash), 'plan.json'), JSON.stringify(now));
    await made(dirname(now.stock.snapshot)); await made(now.candidate.path); await made(now.framework.dir);
    await made(L.updates, 'stock', '.tmp-1-2');
    // another profile's plan names s4 and c4; its boot record names c5; its stable path c6; its last-known-good c7 (layouts WL2-4a review)
    const Q = layoutOf(join(t.d, 'root'), 'other');
    const theirs = plan('d'.repeat(32), 's4', 'c4', null);
    await writeFile(join(await made(Q.profileUpdates, theirs.hash), 'plan.json'), JSON.stringify(theirs));
    await made(dirname(theirs.stock.snapshot)); await made(theirs.candidate.path);
    await writeFile(join(await made(Q.generations), '3.json'), JSON.stringify({ appCandidate: join(L.apps, 'c5', 'ChatGPT Mods.app') }));
    await made(L.apps, 'c6', 'ChatGPT Mods.app');
    await symlink(join(L.apps, 'c6', 'ChatGPT Mods.app'), join(t.d, 'stable.app'));
    await writeFile(Q.profileConfig, JSON.stringify({ appPath: join(t.d, 'stable.app') }));
    await writeFile(Q.lkgApp, join(L.apps, 'c7', 'ChatGPT Mods.app'));
    // this profile's older plans named those same candidates
    for (const [h, c] of [['e', 'c5'], ['f', 'c6'], ['0', 'c7']]) {
      const x = plan(h.repeat(32), 's1', c, null);
      await writeFile(join(await made(L.profileUpdates, x.hash), 'plan.json'), JSON.stringify(x));
      await made(x.candidate.path);
    }
    // another profile stages now (its lease, its process alive): the shared files wait; this profile's older plans go all the same
    await writeFile(join(await made(L.updates, 'leases'), 'other.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
    await pruneOlder(L, now, async (dir) => dir === join(L.apps, 'c2'));
    assert.deepEqual(await Promise.all([join(L.profileUpdates, 'a'.repeat(32)), join(L.updates, 'stock', 's1'), join(L.apps, 'c1')].map(exists)), [false, true, true], 'shared files left while another stages');
    await rm(join(L.updates, 'leases', 'other.json'));
    for (const p of old) await writeFile(join(await made(L.profileUpdates, p.hash), 'plan.json'), JSON.stringify(p));
    await pruneOlder(L, now, async (dir) => dir === join(L.apps, 'c2'));
    assert.deepEqual(await Promise.all(['s4', 'c4', 'c5', 'c6', 'c7'].map((n) => exists(n.startsWith('s') ? join(L.updates, 'stock', n) : join(L.apps, n)))), [true, true, true, true, true],
      'what another profile names stays');
    assert.deepEqual(await Promise.all([join(L.profileUpdates, 'a'.repeat(32)), join(L.profileUpdates, 'b'.repeat(32)), join(L.updates, 'stock', 's1'), join(L.updates, 'stock', 's2'),
      join(L.updates, 'framework', 'f1'), join(L.apps, 'c1')].map(exists)), [false, false, false, false, false, false]);
    assert.ok(await exists(join(L.apps, 'c2')), 'a candidate the copy uses stays');
    assert.deepEqual(await Promise.all([join(L.profileUpdates, now.hash), dirname(now.stock.snapshot), now.framework.dir, join(L.apps, 'c3'), join(L.updates, 'stock', '.tmp-1-2')].map(exists)),
      [true, true, true, true, true], 'the newer plan\'s, and a staging\'s temporary directory (cleanup\'s)');
  } finally { await t.done(); }
});

test('F11: staging shows every installed mod (on the build it runs and on the candidate, what it uses), says each step, and takes a mod\'s GitHub release as a candidate, kept with the plan by its digest', async () => {
  const t = await tmp();
  try {
    const offerFile = join(t.d, 'acme.ok-1.1.0.codexmod');
    await writeFile(offerFile, 'a signed package');
    const sha = (await import('node:crypto')).createHash('sha256').update('a signed package').digest('hex');
    const verified = [];
    const packages = { verify: async (pkg, opts) => { verified.push([pkg, opts.digest]); return { manifest: { id: 'acme.ok', version: '1.1.0', permissions: ['secrets'] }, publisher: 'p', dir: join(t.d, 'extracted') }; } };
    const github = { repo: 'acme/ok', repoId: 7, tag: 'v1.1.0', digest: `sha256:${sha}` };
    const steps = [];
    const f = await stagingFixture(t, { packages, modOffers: () => [{ id: 'acme.ok', version: '1.1.0', file: offerFile, github }], onStep: (x) => steps.push(x) });
    const r = await f.staging.stage({ id: '27.1-101|-', stock: { app: f.stock, build: '27.1-101' } });
    assert.ok(r.plan, JSON.stringify(r));
    assert.deepEqual(steps, ['snapshot', 'pack', 'evidence', 'candidate', 'mods', 'plan']);
    const plan = await readPlan(f.L, r.plan.hash);
    assert.deepEqual(plan.display.map((d) => [d.id, d.on, d.now, d.verdict]), [['acme.off', false, 'blocked', 'compatible'], ['acme.ok', true, 'compatible', 'compatible'], ['acme.risky', true, 'compatible', 'atRisk']]);
    const risky = plan.display.find((d) => d.id === 'acme.risky');
    assert.deepEqual([risky.uses.map((x) => x.id), risky.changed, risky.missing, risky.unchecked, risky.unknown], [['exposure:Select'], [], [], ['exposure:Select'], true]);
    const ok = plan.enabled.find((m) => m.id === 'acme.ok');
    const kept = join(f.L.profileUpdates, 'packages', `${sha}.codexmod`);
    assert.deepEqual([ok.incoming.version, ok.incoming.package, ok.incoming.sha256, ok.incoming.github, ok.incoming.addedPermissions], ['1.1.0', kept, sha, github, ['secrets']]);
    assert.deepEqual(verified, [[kept, `sha256:${sha}`]], 'the copy kept, checked by its digest');
    assert.deepEqual(plan.display.find((d) => d.id === 'acme.ok').candidate, { version: '1.1.0', verdict: 'compatible', addedPermissions: ['secrets'], from: 'github' });
    assert.equal(planHashOf({ ...plan, display: [] }), plan.hash, 'what the page shows is not an input of the plan');
    // the same inputs again, with a mod removed since: the same plan, what the page shows of the mods read again
    const was = f.mods['acme.off'];
    delete f.mods['acme.off'];
    const same = await f.staging.stage({ id: '27.1-101|-', stock: { app: f.stock, build: '27.1-101' } });
    assert.equal(same.plan.hash, r.plan.hash);
    assert.deepEqual((await readPlan(f.L, r.plan.hash)).display.map((d) => d.id), ['acme.ok', 'acme.risky']);
    f.mods['acme.off'] = was;
    // another repository (renamed, moved or replaced): not taken here; the mod's own update asks consent for it
    f.mods['acme.ok'].source = { ...f.mods['acme.ok'].source, repoId: 8 };
    const moved = await f.staging.stage({ id: '27.1-101|-', stock: { app: f.stock, build: '27.1-101' } });
    assert.equal((await readPlan(f.L, moved.plan.hash)).enabled.find((m) => m.id === 'acme.ok').incoming, undefined);
    f.mods['acme.ok'].source = { ...f.mods['acme.ok'].source, repoId: 7 };
    // a package that is not what its release says is not a candidate
    await writeFile(offerFile, 'something else');
    await rm(join(f.L.profileUpdates, 'packages'), { recursive: true, force: true });
    const again = await f.staging.stage({ id: '27.1-101|-', stock: { app: f.stock, build: '27.1-101' } });
    assert.equal((await readPlan(f.L, again.plan.hash)).enabled.find((m) => m.id === 'acme.ok').incoming, undefined);
  } finally { await t.done(); }
});

test('F11: staging cancelled while its builder runs is a cancel, not a problem, whatever the killed builder says', async () => {
  const t = await tmp();
  try {
    let started;
    const running = new Promise((r) => { started = r; });
    const f = await stagingFixture(t, { slowBuilder: async () => { started(); await new Promise((r) => setTimeout(r, 300)); throw new Error('the builder failed (exit null)'); } });
    const staged = f.staging.stage({ id: '27.1-101|-', stock: { app: f.stock, build: '27.1-101' } });
    await running;
    await f.staging.cancel();
    assert.deepEqual(await staged, { cancelled: true });
    assert.equal(f.staging.status(), null);
  } finally { await t.done(); }
});

test('staging: a build that cannot be made is a problem, not a plan', async () => {
  const t = await tmp();
  try {
    const f = await stagingFixture(t, { packFor: null });
    const r = await f.staging.stage({ id: '27.1-101|-', stock: { app: f.stock, build: '27.1-101' } });
    assert.equal(r.plan, undefined);
    assert.match(r.problem, /this build cannot be made: mandatory edit cua-bundle-id/);
  } finally { await t.done(); }
});

test('the detector: an offer for another stock build, staged at most three times a day; dismissed by Later; the status names the plan and its verdict', async () => {
  const t = await tmp();
  try {
    const f = await stagingFixture(t);
    const state = createUpdateState(f.L);
    let fail = true;
    const staging = { status: () => null, stage: async (offer) => (fail ? { problem: 'no network' } : f.staging.stage(offer)) };
    const d = createDetector({ layout: f.L, copyBuild: '27.0-100', frameworkVersion: '1.0.0', stockApp: f.stock, source: createReleaseSource(null, f.L), staging, state,
      busy: () => false, safe: () => false, pollMs: 3_600_000 });
    await d.start();
    await d.stop();
    assert.equal(d.offer().stock.build, '27.1-101');
    for (let i = 0; i < 4; i++) await d.stageNow({ userAsked: false });
    assert.equal((await state.load()).attempts['27.1-101|-'].n, 3, 'three automatic attempts a day');
    await d.stageNow();
    assert.equal((await state.load()).attempts['27.1-101|-'].n, 4, 'the user\'s ask runs whatever was tried today, and counts');
    assert.match((await d.status()).problem.problem, /no network/);
    // a new day: staged
    await state.update((s) => { s.attempts = {}; });
    fail = false;
    await d.stageNow();
    const st = await d.status();
    assert.equal(st.plan.build, '27.1-101');
    assert.equal(st.plan.held, true);
    assert.equal(st.plan.risks[0].mod, 'acme.risky');
    await state.update((s) => { s.dismissed.push(st.offer.id); });
    assert.equal((await d.status()).offer.dismissed, true);
    // Later means later: an automatic attempt leaves a dismissed offer alone; the user's Prepare still runs (F11)
    await state.update((s) => { s.attempts = {}; s.latestPlan = null; });
    assert.equal(await d.stageNow({ userAsked: false }), null);
    assert.equal((await state.load()).attempts['27.1-101|-'], undefined, 'not even tried');
    assert.ok((await d.stageNow()).plan);
  } finally { await t.done(); }
});

test('a check of today is judged again against the framework that runs now, as not asked', async () => {
  const t = await tmp();
  try {
    await releaseTree(join(t.d, 'rel', 'a'), '1.0.1');
    const L = layoutOf(join(t.d, 'root'));
    const state = createUpdateState(L);
    const source = createReleaseSource({ kind: 'dir', path: join(t.d, 'rel') }, L);
    const mk = (frameworkVersion) => createDetector({ layout: L, copyBuild: '27.0-100', frameworkVersion, stockApp: join(t.d, 'none.app'), source,
      staging: { status: () => null, stage: async () => ({}) }, state, busy: () => false, safe: () => false, pollMs: 3_600_000 });
    const asked = mk('1.0.0-dev+aaaa1111');
    await asked.check();
    await asked.stop();
    assert.equal(asked.offer().release.version, '1.0.1', 'asked: a development framework is offered the release');
    const later = mk('1.0.0-dev+bbbb2222');
    await later.start(); await later.stop();
    assert.equal(later.offer(), null, 'not asked again: not offered on its own');
    const newer = mk('1.0.2+cccc3333');
    await newer.start(); await newer.stop();
    assert.equal(newer.offer(), null, 'never an older release');
  } finally { await t.done(); }
});

test('a plan made for other enabled mods is not offered as ready, and staging makes another (E6 acceptance)', async () => {
  const t = await tmp();
  try {
    const f = await stagingFixture(t);
    const state = createUpdateState(f.L);
    let enabled = null;
    const d = createDetector({ layout: f.L, copyBuild: '27.0-100', frameworkVersion: '1.0.0', stockApp: f.stock, source: createReleaseSource(null, f.L), staging: f.staging, state,
      busy: () => false, safe: () => false, pollMs: 3_600_000, enabledNow: () => enabled ?? [] });
    await d.start();
    await d.stop();
    const first = await d.stageNow();
    enabled = (first.plan.enabled ?? []).map((m) => `${m.id}@${m.version}`).sort();
    assert.ok((await d.status()).plan, 'made for the mods enabled now: ready');
    enabled = [...enabled, 'acme.new@1.0.0'];
    assert.equal((await d.status()).plan, null, 'another mod enabled since: not offered as ready');
    const second = await d.stageNow();
    assert.ok(second && (second.plan || second.problem), 'staged again');
    // F11: a mod installed or removed since, even one that is off: the plan shows them all, so it is staged again
    let installed = ['acme.off@1.0.0', 'acme.ok@1.0.0', 'acme.risky@1.0.0'];
    const d2 = createDetector({ layout: f.L, copyBuild: '27.0-100', frameworkVersion: '1.0.0', stockApp: f.stock, source: createReleaseSource(null, f.L), staging: f.staging, state,
      busy: () => false, safe: () => false, pollMs: 3_600_000, enabledNow: () => ['acme.ok@1.0.0', 'acme.risky@1.0.0'], installedNow: () => installed });
    await d2.start();
    await d2.stop();
    await state.update((s) => { s.attempts = {}; });
    assert.equal(await d2.stageNow(), null, 'the plan shows the mods installed now: nothing to do');
    installed = [...installed, 'acme.zzz@1.0.0'];
    assert.ok(await d2.stageNow(), 'one installed since: staged again');
  } finally { await t.done(); }
});

test('F11: a release says which builds it supports (a build, or a version prefix); a malformed list is refused', async () => {
  assert.equal(supportsBuild(['26.1027'], '26.1027.30824-22943'), true);
  assert.equal(supportsBuild(['26.1027.30824-22943'], '26.1027.30824-22943'), true);
  assert.equal(supportsBuild(['26.102'], '26.1027.30824-22943'), false, 'a prefix ends at a dot or a dash');
  assert.equal(supportsBuild(undefined, '26.1027'), null, 'it says nothing');
  const t = await tmp();
  try {
    const dir = join(t.d, 'r');
    await releaseTree(dir, '1.1.0');
    const rel = JSON.parse(await readFile(join(dir, 'release.json'), 'utf8'));
    await writeFile(join(dir, 'release.json'), JSON.stringify({ ...rel, supports: ['26.1027'] }));
    // the tree's hash covers release.json? it does not: the record is beside the tree it names
    assert.deepEqual((await verifyReleaseTree(dir)).supports, ['26.1027']);
    await writeFile(join(dir, 'release.json'), JSON.stringify({ ...rel, supports: '26.1027' }));
    await assert.rejects(verifyReleaseTree(dir), /supports must be a list of Codex builds/);
  } finally { await t.done(); }
});

test('F11: the detector says the framework\'s support from explicit outcomes, and whether the automatic policy will act', async () => {
  const t = await tmp();
  try {
    const f = await stagingFixture(t);
    const state = createUpdateState(f.L);
    let result = { problem: 'this build cannot be made: no pack', code: 'Incompatible' }, running = null;
    const staging = { status: () => running, stage: async (offer) => (result ? result : f.staging.stage(offer)) };
    const d = createDetector({ layout: f.L, copyBuild: '27.0-100', frameworkVersion: '1.0.0', stockApp: f.stock, source: createReleaseSource(null, f.L), staging, state,
      busy: () => false, safe: () => false, pollMs: 3_600_000 });
    await d.start();
    await d.stop();
    // staged once on its own at start: a build no release can make yet
    assert.deepEqual((await d.status()).support, { status: 'notYet', problem: 'this build cannot be made: no pack' });
    result = { problem: 'the release source cannot be reached', unknown: true };
    await d.stageNow();
    assert.equal((await d.status()).support.status, 'unknown');
    running = { offer: '27.1-101|-', step: 'candidate' };
    assert.deepEqual((await d.status()).support, { status: 'checking' });
    running = null;
    result = null;
    await d.stageNow();
    assert.deepEqual((await d.status()).support, { status: 'already' }, 'made and checked by the framework that runs');
    assert.deepEqual((await d.status()).auto, { will: false, why: 'off' });
    await state.update((s) => { s.policy = 'auto'; });
    assert.deepEqual((await d.status()).auto, { will: false, why: 'held' }, 'a held plan is not applied on its own');
    await state.update((s) => { s.auto['27.1-101|-'] = { at: 'x' }; });
    assert.deepEqual((await d.status()).auto, { will: false, why: 'tried' }, 'an offer tried once is never applied on its own again');
    const idle = createDetector({ layout: f.L, copyBuild: '27.0-100', frameworkVersion: '1.0.0', stockApp: f.stock, source: createReleaseSource(null, f.L), staging: { status: () => null, stage: async () => ({}) },
      state: createUpdateState({ ...f.L, profileUpdates: join(t.d, 'other-updates') }), busy: () => true, safe: () => false, pollMs: 3_600_000 });
    await idle.start();
    await idle.stop();
    assert.deepEqual((await idle.status()).support, { status: 'notChecked' }, 'nothing tried yet');
  } finally { await t.done(); }
});
