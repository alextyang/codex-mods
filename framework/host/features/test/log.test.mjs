// The feature log on the shipped packs (docs/design/systems.md S16 to S18, "E4 in detail"): the log is what the code gives; the 21477 and
// 20770 packs report every feature from their evidence (20770's real differences missing, its locator misses unknown); a mod that needs a
// missing feature is blocked and one that needs an unseen one at risk, each with its sentence; one operation's missing method blocks only
// what needs that operation; a breaking version; a changed method's shape; a binding's tripped canary reaching the Mods that need it; the
// running copy's check and a candidate's agree on the same evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { evidenceFor, loadLog } from '../evidence.mjs';
import { evaluate } from '../status.mjs';
import { computeCompatibility } from '../../ops/compat.mjs';
import { SDK_FEATURES } from '../sdk.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const ADDRESSES = read('framework/renderer/present/addresses.json');
const log = await loadLog();
async function onBuild(build, change) {
  const pack = read(`adapters/${build}/adapter.json`);
  const ev = await evidenceFor({ pack, dirs: [join(ROOT, 'adapters')], addresses: ADDRESSES });
  if (change) change(ev);
  return { ev, evaluation: evaluate(log, ev) };
}
const B25679 = '26.1103.41825-25679', B22943 = '26.1027.30824-22943', B21477 = '26.1016.62342-21477', B20770 = '26.1013.40934-20770';
const compat = (manifest, e) => computeCompatibility(manifest, { log, evaluation: e.evaluation });

test('the log is what the code gives, and the scan\'s residue is declared', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'features.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Object.keys(log.features).length > 250 && Object.keys(log.mechanics).length > 150);
  assert.deepEqual(log.reference.builds, [B25679, B22943, B21477, B20770]);
});

test('the SDK\'s entries name every namespace of its contexts (sdk/index.d.ts)', () => {
  const dts = readFileSync(join(ROOT, 'sdk', 'index.d.ts'), 'utf8');
  const ns = new Set();
  for (const ctx of ['HostContext', 'RendererContext']) {
    const body = dts.slice(dts.indexOf(`export interface ${ctx} {`)).split('\n}')[0];
    for (const m of body.matchAll(/^\s+readonly (\w+):/gm)) ns.add(m[1]);
  }
  const ids = new Set(SDK_FEATURES.map((f) => f.id));
  assert.deepEqual([...ns].filter((n) => !ids.has(n)), []);
});

test('the 21477 pack reports every feature present; 20770 the services 21477 added missing, and its locator misses unknown', async () => {
  const a = await onBuild(B21477), b = await onBuild(B20770);
  assert.deepEqual(Object.values(a.evaluation.features).filter((f) => f.status !== 'present'), []);
  const missing = Object.entries(b.evaluation.mechanics).filter(([, m]) => m.status === 'missing').map(([id]) => id).sort();
  assert.deepEqual(missing, ['service:accountInfo', 'service:agentInstructions', 'service:commandKeybindings', 'service:commentAttachments',
    'service:gitRepository', 'service:queryCache', 'service:recommendedSkills', 'service:repositoryOrigins']);
  assert.equal(b.evaluation.status('exposure:ComposerDropdown').status, 'unknown', 'a locator miss, never missing');
  assert.equal(b.evaluation.features['graph:Repository.switchBranch'].status, 'missing');
  assert.equal(b.evaluation.features['graph:GitRepository'].status, 'present', 'the repository reads without the app\'s gitRepository handles');
  assert.equal(b.evaluation.features['graph:ChatGPTAccount'].status, 'present', 'its account facts are preferred, and 20770 has accessInputs');
});

test('a mod that needs a missing feature is blocked, one that needs an unseen one at risk, each with its sentence, on both packs', async () => {
  for (const build of [B21477, B20770]) {
    const e = await onBuild(build);
    const blocked = compat({ requires: { features: ['anchor:statusbar'] } }, e);
    assert.equal(blocked.status, 'blocked', build);
    assert.equal(blocked.reasons[0].sentence, 'It needs the statusbar anchor, which this build of the app lacks (this build\'s pack has no such anchor).');
    const risky = compat({ requires: { features: ['exposure:Select'] } }, e);
    assert.equal(risky.status, 'atRisk', build);
    assert.match(risky.reasons[0].sentence, /^It needs the app's Select \(as the copy exposes it\), which could not be checked on this build of the app/);
  }
  const old = await onBuild(B20770);
  const pr = compat({ requires: { features: ['graph:Repository.push'] }, optional: { features: ['graph:Comment'] } }, old);
  assert.equal(pr.status, 'blocked');
  assert.equal(pr.reasons[0].sentence, 'It needs the Repository.push operation, which this build of the app lacks: the app\'s gitRepository service (it is not in this build).');
  assert.equal(pr.reasons[1].sentence, 'It works without the Comment type, which this build of the app lacks: the app\'s commentAttachments service (it is not in this build).');
  assert.equal(compat({ requires: { features: ['graph:GitRepository'] } }, old).status, 'compatible', 'one operation\'s missing service blocks only what needs that operation');
  assert.equal(compat({ requires: { features: ['graph:Nope'] } }, old).reasons[0].sentence, 'It needs graph:Nope, which this framework does not know.');
  assert.equal(compat({ permissions: ['graph.act:Repository.push'] }, old).status, 'degraded', 'a grant is a hint: optional');
});

test('what is on screen can be read where its presentation is realized: the maintained mods are compatible on 22943', async () => {
  const e = await onBuild(B22943);
  assert.equal(compat({ permissions: ['graph.read:Window', 'graph.act:Window.open'] }, e).status, 'compatible', 'a read of the windows provider\'s Window');
  const { readdirSync } = await import('node:fs');
  for (const id of readdirSync(join(ROOT, 'mods')).filter((d) => d.startsWith('codexmods.'))) {
    const c = compat(read(`mods/${id}/mod.json`), e);
    assert.equal(c.status, 'compatible', `${id}: ${(c.reasons ?? []).map((r) => r.sentence).join(' ')}`);
  }
});

test('versions: a requirement written for another epoch of a feature is missing for it', async () => {
  const e = await onBuild(B21477);
  const c = compat({ requires: { features: [{ id: 'graph:Thread', version: 2 }] } }, e);
  assert.equal(c.status, 'blocked');
  assert.equal(c.reasons[0].sentence, 'It was written for version 2 of the Thread type; this framework has version 1.');
  assert.equal(compat({ requires: { features: [{ id: 'graph:Thread', version: 1 }, 'graph:Thread'] } }, e).status, 'compatible');
});

test('a method whose shape changed (its result only) is changed, and so is what needs it: at risk', async () => {
  const e = await onBuild(B21477, (ev) => {
    const fam = ev.facts.families['protocol.schema'];
    ev.facts = { ...ev.facts, families: { ...ev.facts.families, 'protocol.schema': { ...fam, fingerprints: { ...fam.fingerprints, 'ClientRequest:thread/name/set': '0000000000000000' } } } };
  });
  assert.equal(e.evaluation.status('protocol:thread/name/set').status, 'changed');
  assert.equal(e.evaluation.features['graph:Thread.rename'].status, 'changed');
  assert.equal(e.evaluation.features['graph:Thread'].status, 'present', 'reading threads does not need it');
  assert.equal(compat({ requires: { features: ['graph:Thread.rename'] } }, e).status, 'atRisk');
});

test('a binding\'s tripped canary makes its presentation changed, and the mods that need it at risk', async () => {
  const e = await onBuild(B21477, (ev) => { ev.live = { bindings: { 'turn.view': { state: 'tripped', why: 'its canary failed: turnId is null' } }, anchors: [] }; });
  assert.equal(e.evaluation.features['presentation:TurnView'].status, 'changed');
  const c = compat({ requires: { features: ['presentation:TurnView'] } }, e);
  assert.equal(c.status, 'atRisk');
  assert.match(c.reasons[0].sentence, /its canary tripped: its canary failed: turnId is null/);
});

test('the running copy\'s check and a candidate\'s agree on the same evidence; another build\'s census is stale and reads unknown', async () => {
  const manifest = { requires: { methods: ['thread/start'], features: ['graph:Comment'] }, optional: { features: ['anchor:composer'] } };
  const a = compat(manifest, await onBuild(B20770)), b = compat(manifest, await onBuild(B20770));
  assert.deepEqual(a, b);
  assert.equal(a.status, 'blocked');
  const stale = await onBuild(B21477, (ev) => { ev.stale = ['census']; });
  assert.equal(stale.evaluation.status('service:gitRepository').status, 'unknown');
});
