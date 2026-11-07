// The framework's provider (docs/design/systems.md S1 to S4, docs/graph/07): CodexMods, Mods and Operations read from the management
// dispatcher, operations as management mutations answered with their Operation, and the authority the policy gives mods over them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createGraph } from '../../../index.mjs';
import { createPolicy } from '../../../policy.mjs';
import { createGraphNs } from '../../../../ctx/graph.mjs';
import { toDescriptor } from '../../../../../../sdk/graph/define.mjs';
import { NATIVE_TYPES } from '../../../../../../sdk/graph/native/index.mjs';
import { FRAMEWORK_TYPES } from '../../../../../../sdk/graph/framework.mjs';
import { createFrameworkSource, refs, modData, modStateOf, operationData, keptOps, reasonsOf, permissionsOf, copyUpdateData, placesOf, recommendedOf, PROVIDER, KIND } from '../index.mjs';

const USER = { kind: 'user', id: 'user', owner: 'app' };
const mod = (id) => ({ kind: 'mod', id, owner: `mod:${id}` });

const RECORD = (id, extra = {}) => ({
  id, name: id === 'unit.a' ? 'Unit A' : 'Unit B', version: '1.0.0', status: 'enabled', dev: false, publisherFingerprint: 'abcd1234abcd1234',
  compatibility: 'compatible', hasSettings: false, pendingUpdate: null, quarantine: null, ...extra,
});
const OP = (id, input, outcome = 'running', extra = {}) => ({ id, input, outcome, phases: [{ name: 'start', at: '2026-10-27T10:00:00.000Z' }], startedAt: '2026-10-27T10:00:00.000Z', ...extra });

/** A management stand-in that answers the reads the provider makes and records every mutation; `emit` pushes events. */
function fakeManagement() {
  const state = {
    mods: [RECORD('unit.a'), RECORD('unit.b', { status: 'disabled' })],
    ops: [OP('op-0000000000000001', { type: 'install', source: '/tmp/a.codexmod' }, 'succeeded', { endedAt: '2026-10-27T10:00:05.000Z' })],
    safeMode: false,
    compat: { 'unit.a': { status: 'compatible', missingRequired: [], missingOptional: [] }, 'unit.b': { status: 'degraded', missingRequired: [], missingOptional: ['the anchor statusbar'] } },
    features: { build: '26.1016.62342-21477', log: { hash: 'h', reference: [] }, evidence: null,
      features: [{ id: 'graph:Thread', kind: 'feature', title: 'the Thread type', version: 1, status: 'present', because: [], needs: ['protocol:thread/read', { anyOf: ['service:a', 'service:b'] }], realizedBy: ['graph:CodexThread'] }],
      mechanics: [{ id: 'protocol:thread/read', kind: 'mechanic', title: 'the app-server method thread/read', status: 'present', why: 'in this build\'s schema', units: ['core:conversation'] }] },
  };
  const calls = [];
  const listeners = new Set();
  let next = 2;
  const results = {
    'mods.list': () => ({ mods: state.mods }),
    'mods.inspect': ({ modId }) => {
      const r = state.mods.find((m) => m.id === modId);
      return { ...r, manifest: { id: r.id, name: r.name, description: 'A unit mod', permissions: ['graph.read:Thread', 'ui'] }, grants: ['graph.read:Thread'] };
    },
    'compat.report': () => ({ appBuild: 'x', adapterVersion: 'y', probes: {}, complete: true, mods: state.compat }),
    'features.list': () => state.features,
    'ops.list': () => ({ ops: state.ops }),
    'ops.get': ({ opId }) => state.ops.find((o) => o.id === opId),
    'diagnostics': () => ({ host: { safeMode: state.safeMode, developerMode: state.developerMode === true } }),
    'framework.developerMode': ({ on }) => { state.developerMode = on; return { developerMode: on }; },
    'updates.status': () => ({ framework: { current: '0.9.0+abcd1234', previous: null }, app: null, lkg: { appBuild: '26.1016.62342-21477', frameworkVersion: '0.9.0+abcd1234', healthyAt: '2026-10-27T09:00:00.000Z' }, ...(state.updates ?? {}) }),
  };
  return {
    state, calls,
    emit(event) { for (const fn of [...listeners]) fn(event); },
    subscribe(fn) { listeners.add(fn); return { dispose() { listeners.delete(fn); } }; },
    async handle({ id, method, params }) {
      calls.push({ method, params });
      if (results[method]) return { id, ok: true, result: results[method](params ?? {}) };
      const opId = `op-${String(next++).padStart(16, '0')}`;
      state.ops.push(OP(opId, { type: method === 'mods.disable' ? 'disable' : 'enable', ...(params?.modId ? { modId: params.modId } : {}) }));
      return { id, ok: true, result: { opId } };
    },
  };
}

async function setup(grants = new Map()) {
  let graph = null;
  const policy = createPolicy({ grantsOf: (id) => grants.get(id), typeOf: (id) => graph.type(id) });
  graph = createGraph({ authorize: policy.authorize });
  graph.registerTypes(NATIVE_TYPES.map(toDescriptor), 'native');
  graph.registerTypes(FRAMEWORK_TYPES.map(toDescriptor), 'framework');
  const management = fakeManagement();
  const source = createFrameworkSource({ graph, management, frameworkVersion: '0.9.0+abcd1234' });
  await source.ready;
  const ns = createGraphNs({ graph: () => graph });
  const as = (id, g) => { grants.set(id, g); return { realm: 'host', state: { id, owner: `mod:${id}`, grants: g } }; };
  return { graph, management, source, ns, as, policy };
}

test('the framework is one CodexMods, its Mods in order and its Operations, read from management', async () => {
  const { graph } = await setup();
  const fw = graph.resolve(refs.codexMods());
  assert.equal(fw.state.version, '0.9.0+abcd1234');
  assert.equal(fw.state.safeMode, false);
  assert.equal(fw.state.updatePolicy, 'offer');
  assert.deepEqual(fw.state.lastKnownGood, { app: '26.1016.62342-21477', framework: '0.9.0+abcd1234', at: Date.parse('2026-10-27T09:00:00.000Z') });
  assert.deepEqual(fw.links.mods.map((r) => r.id), ['unit.a', 'unit.b']);
  const a = graph.resolve(refs.mod('unit.a'));
  assert.equal(a.ref.provider, PROVIDER);
  assert.deepEqual([a.state.name, a.state.status, a.state.compatibility, a.state.development, a.state.description], ['Unit A', 'enabled', 'compatible', false, 'A unit mod']);
  assert.deepEqual(a.state.permissions.map((p) => [p.id, p.granted]), [['graph.read:Thread', true], ['ui', false]]);
  const b = graph.resolve(refs.mod('unit.b'));
  assert.deepEqual([b.state.status, b.state.compatibility, b.state.reasons], ['disabled', 'degraded', ['It works without the anchor statusbar, which this build of the app lacks.']]);
  const op = graph.resolve(refs.operation('op-0000000000000001'));
  assert.deepEqual([op.state.kind, op.state.outcome, op.state.phase], ['install', 'succeeded', 'start']);
  assert.equal(op.links.mod, null);
});

test('an operation is a management mutation: it answers with its Operation at once, and the outcome follows the op events', async () => {
  const { graph, management } = await setup();
  const out = await graph.invoke({ ref: refs.mod('unit.a'), operation: 'disable', caller: USER, origin: 'app' });
  assert.equal(out.status, 'done');
  assert.equal(out.value.type, 'Operation');
  assert.deepEqual(management.calls.filter((c) => c.method === 'mods.disable'), [{ method: 'mods.disable', params: { modId: 'unit.a' } }]);
  const opRef = out.value;
  assert.equal(graph.resolve(opRef).state.outcome, 'running', 'accepted, not finished');
  const events = [];
  graph.subscribe({ ref: opRef }, (e) => events.push(e));
  const finished = { ...management.state.ops.find((o) => o.id === opRef.id), outcome: 'succeeded', endedAt: '2026-10-27T10:01:00.000Z' };
  management.state.ops = management.state.ops.map((o) => (o.id === opRef.id ? finished : o));
  management.emit({ event: 'op', data: finished });
  assert.equal(graph.resolve(opRef).state.outcome, 'succeeded');
  // The other operations map to their mutations with their arguments.
  await graph.invoke({ ref: refs.mod('unit.b'), operation: 'remove', args: [true], caller: USER, origin: 'app' });
  await graph.invoke({ ref: refs.mod('unit.b'), operation: 'rollback', args: ['0.9.0', false], caller: USER, origin: 'app' });
  await graph.invoke({ ref: refs.codexMods(), operation: 'enterSafeMode', caller: USER, origin: 'app' });
  const mutations = management.calls.filter((c) => !['mods.list', 'mods.inspect', 'compat.report', 'features.list', 'ops.list', 'ops.get', 'diagnostics', 'updates.status'].includes(c.method));
  assert.deepEqual(mutations.slice(1), [
    { method: 'mods.remove', params: { modId: 'unit.b', deleteData: false } },
    { method: 'mods.rollback', params: { modId: 'unit.b', toVersion: '0.9.0', restoreData: false } },
    { method: 'recovery.safeMode', params: { enter: true } },
  ]);
});

test('a refused mutation is the management error, not a new Operation', async () => {
  const { graph, management } = await setup();
  management.handle = async ({ id }) => ({ id, ok: false, error: { code: 'Conflict', message: 'another operation is running' } });
  const out = await graph.invoke({ ref: refs.mod('unit.a'), operation: 'enable', caller: USER, origin: 'app' });
  assert.equal(out.status, 'failed');
  assert.match(out.error?.message ?? out.message ?? JSON.stringify(out), /another operation is running/);
});

test('a removed mod leaves the graph; a changed one emits changed', async () => {
  const { graph, management, source } = await setup();
  const changes = [];
  graph.subscribe({ ref: refs.mod('unit.a') }, (e) => changes.push(e));
  management.state.mods = [RECORD('unit.a', { status: 'quarantined', quarantine: { reason: '3 faults', at: '2026-10-27T11:00:00.000Z' } })];
  management.emit({ event: 'mods', data: {} });
  await source.refresh();
  assert.equal(graph.resolve(refs.mod('unit.a')).state.status, 'quarantined');
  assert.deepEqual(graph.resolve(refs.mod('unit.a')).state.quarantine, { reason: '3 faults', at: Date.parse('2026-10-27T11:00:00.000Z') });
  const gone = graph.resolve(refs.mod('unit.b'));
  assert.ok(!gone || gone.gone, 'unit.b was removed');
  assert.deepEqual(graph.resolve(refs.codexMods()).links.mods.map((r) => r.id), ['unit.a']);
});

test('authority (S4): no mod acts on framework instances, whatever it was granted; it reads its own Mod; reading others needs graph.read', async () => {
  const grants = new Map();
  const { graph, ns, as } = await setup(grants);
  // act: refused even with every graph grant.
  grants.set('unit.a', ['graph', 'graph.act', 'graph.read', 'graph.intercept']);
  const out = await graph.invoke({ ref: refs.mod('unit.b'), operation: 'disable', caller: mod('unit.a'), origin: 'mod' });
  assert.equal(out.status, 'refused');
  const own = await graph.invoke({ ref: refs.mod('unit.a'), operation: 'disable', caller: mod('unit.a'), origin: 'mod' });
  assert.equal(own.status, 'refused', 'not even its own disabling');
  const safe = await graph.invoke({ ref: refs.codexMods(), operation: 'enterSafeMode', caller: mod('unit.a'), origin: 'mod' });
  assert.equal(safe.status, 'refused');
  // Through the mod ingress the refusal says why.
  const viaIngress = ns.calls.invoke(as('unit.a', ['graph', 'graph.act']), refs.mod('unit.b'), 'disable', []);
  assert.match((await viaIngress).message, /the framework's instances are the user's/);
  // read: its own Mod without a grant; another Mod with graph.read only.
  const scopeB = as('unit.b', ['graph']);
  assert.ok(ns.calls.resolve(scopeB, refs.mod('unit.b')), 'its own Mod');
  assert.equal(ns.calls.resolve(scopeB, refs.mod('unit.a')), null, 'another Mod needs graph.read');
  assert.equal(ns.calls.resolve(scopeB, refs.codexMods()), null);
  const scopeR = as('unit.r', ['graph', 'graph.read:Mod']);
  assert.ok(ns.calls.resolve(scopeR, refs.mod('unit.a')));
});

test('authority (S4): interceptors cannot reach framework instances, even through a concept they may intercept; the copy\'s update included (B5)', async () => {
  const grants = new Map([['unit.i', ['graph', 'graph.intercept']]]);
  const { graph, policy } = await setup(grants);
  const caller = mod('unit.i');
  assert.equal(policy.allows(caller, 'intercept', 'Mod', null, 'disable'), false, 'a framework type, whatever the grant');
  for (const op of ['install', 'installAnyway', 'apply', 'download']) assert.equal(policy.allows(caller, 'intercept', 'CopyUpdate', null, op), false, `CopyUpdate.${op}: the user's`);
  assert.equal(policy.allows(caller, 'intercept', 'Update', null, 'download'), true, 'the native concept itself stays interceptable');
  // At run time: an interceptor on the concept Update does not see a CopyUpdate's download.
  const seen = [];
  graph.intercept('mod:unit.i', 'Update', 'download', async (call, next) => { seen.push(call.ref.type); return next(); });
  const h = graph.registerProvider('framework', 'unit.copy', { types: { CopyUpdate: { operations: { download: { effect: 'local', handler: () => null } } } } });
  const u = { type: 'CopyUpdate', provider: 'unit.copy', id: 'u1' };
  h.put(u, { state: { version: '2', state: 'available', mods: [], plan: 'p', held: false, risks: [], checked: 'static', dismissed: false }, links: { app: refs.app(), codexMods: refs.codexMods() } });
  const out = await graph.invoke({ ref: u, operation: 'download', caller: USER, origin: 'app' });
  assert.equal(out.status, 'done');
  assert.deepEqual(seen, [], 'the interceptor of Update did not run on the framework\'s CopyUpdate');
});

test('reserved provider ids are never a mod\'s own: a mod called codex does not own the native instances', async () => {
  const { policy } = await setup(new Map([['codex', ['graph']]]));
  assert.equal(policy.allows(mod('codex'), 'act', 'Thread', { type: 'CodexThread', provider: 'codex', id: 't' }, 'archive'), false);
  assert.equal(policy.allows(mod('codex'), 'read', 'Thread', { type: 'CodexThread', provider: 'codex', id: 't' }), false);
});

test('the pure mappings: reasons, permissions, operations kept', () => {
  assert.deepEqual(reasonsOf({ missingRequired: ['the method x'], missingTypes: ['T'], missingBecause: 'unit.base' }),
    ['It needs the method x, which this build of the app lacks.', 'Its types T build on unit.base, which is not running.']);
  assert.deepEqual(permissionsOf({ permissions: ['secrets'] }, [], ['processes']).map((p) => [p.id, p.risk, p.granted]), [['secrets', 'high', false], ['processes', 'high', false]]);
  const ops = Array.from({ length: 60 }, (_, i) => OP(`op-${String(i).padStart(16, '0')}`, { type: 'enable', modId: 'unit.a' }, i === 0 ? 'needs-attention' : 'succeeded', { startedAt: `2026-10-27T10:${String(i).padStart(2, '0')}:00.000Z` }));
  const kept = keptOps(ops);
  assert.equal(kept.length, 51, 'the one needing attention and the latest 50');
  assert.equal(kept[0].outcome, 'needs-attention');
  const acked = keptOps(ops.map((o, i) => (i === 0 ? { ...o, acknowledgedAt: '2026-10-28T00:00:00.000Z' } : o)));
  assert.equal(acked.length, 50, 'acknowledged: bounded like any finished operation (E6 review)');
  assert.ok(!acked.some((o) => o.outcome === 'needs-attention'), 'the oldest, acknowledged, is past the latest 50');
  assert.equal(operationData(OP('op-1', { type: 'clear-quarantine', modId: 'm' }, 'needs-attention', { note: 'check it' })).state.kind, 'clearQuarantine');
  assert.equal(modData({ id: 'm', name: 'M', version: '1', status: 'pending-consent', manifest: {}, grants: [] }, null).state.status, 'pendingConsent');
  // H9 (public-hooks.md §3.16): what it gives the agent now; none when it gives nothing
  const detail = { id: 'm', name: 'M', version: '1', status: 'enabled', manifest: {}, grants: [] };
  assert.deepEqual(modData(detail, null).state.agent, { tools: [], skills: [], instructions: [] });
  assert.deepEqual(modData(detail, null, null, null, undefined, [], { tools: [{ name: 't', description: 'd', extra: 1 }], skills: ['s'], instructions: ['text', 'odd', 'perTurn'] }).state.agent,
    { tools: [{ name: 't', description: 'd' }], skills: ['s'], instructions: ['text', 'perTurn'] });
});

test('the feature log as Features (E4): one per entry and per id a mod names that the log lacks; a Mod links what it needs, with its sentences', async () => {
  const { graph, management, source } = await setup();
  management.state.compat['unit.b'] = { status: 'atRisk', missingRequired: [], missingOptional: [], features: ['graph:Thread', 'graph:Nope'],
    reasons: [{ id: 'graph:Nope', title: 'graph:Nope', status: 'unknown', required: true, sentence: 'It needs graph:Nope, which this framework does not know.' }] };
  management.emit({ event: 'compat', data: {} });
  await source.refresh(true);
  const t = graph.resolve(refs.feature('graph:Thread'));
  assert.deepEqual(t.state, { kind: 'feature', title: 'the Thread type', version: '1', status: 'present' });
  assert.deepEqual(t.links.needs.map((r) => r.id), ['protocol:thread/read', 'service:a', 'service:b', 'graph:CodexThread'], 'what it needs, alternatives and realizations');
  assert.deepEqual(graph.resolve(refs.feature('protocol:thread/read')).state, { kind: 'mechanic', title: 'the app-server method thread/read', version: '1', status: 'present' });
  assert.deepEqual(graph.resolve(refs.feature('graph:Nope')).state, { kind: 'feature', title: 'graph:Nope', version: '1', status: 'unknown' });
  const b = graph.resolve(refs.mod('unit.b'));
  assert.deepEqual([b.state.compatibility, b.state.reasons], ['atRisk', ['It needs graph:Nope, which this framework does not know.']]);
  assert.deepEqual(b.links.features.map((r) => r.id), ['graph:Thread', 'graph:Nope']);
  assert.ok(graph.resolve(refs.codexMods()).links.features.some((r) => r.id === 'graph:Thread'));
  // a status that moves is put again; an id no mod names any more goes
  management.state.features.features[0].status = 'missing';
  management.state.compat['unit.b'] = { status: 'compatible', missingRequired: [], missingOptional: [], features: [], reasons: [] };
  management.emit({ event: 'compat', data: {} });
  await source.refresh(true);
  assert.equal(graph.resolve(refs.feature('graph:Thread')).state.status, 'missing');
  assert.ok(!graph.resolve(refs.feature('graph:Nope')) || graph.resolve(refs.feature('graph:Nope')).gone);
});

test('the copy\'s update (E5): a CopyUpdate per offer with its plan, verdict and risks; install refused when held, installAnyway bound to the plan seen', async () => {
  const { graph, management, source } = await setup();
  assert.equal(graph.resolve(refs.copyUpdate()), null, 'no offer, no update');
  const plan = { hash: 'e'.repeat(32), build: '27.1-101', framework: { from: '0.9.0', to: '1.0.0' }, mods: [{ id: 'unit.a', from: '1.0.0', to: '1.1.0' }], held: true,
    risks: [{ mod: 'unit.b', status: 'atRisk', sentences: ['It needs the Select.'], features: ['exposure:Select'] }], checked: 'static' };
  management.state.updates = { offer: { id: 'x', build: '27.1-101', copyBuild: '27.0-100', framework: { from: '0.9.0', to: '1.0.0' } }, plan, staging: null, policy: 'auto', installing: false };
  await source.refresh(true);
  const cu = graph.resolve(refs.copyUpdate());
  assert.deepEqual([cu.state.state, cu.state.version, cu.state.held, cu.state.plan], ['ready', '27.1-101 with framework 1.0.0', true, 'e'.repeat(32)]);
  assert.deepEqual(cu.state.build, { from: '27.0-100', to: '27.1-101' });
  assert.deepEqual(cu.state.risks, [{ mod: refs.mod('unit.b'), feature: refs.feature('exposure:Select'), sentence: 'It needs the Select.' }]);
  assert.deepEqual(cu.state.mods, [{ mod: refs.mod('unit.a'), from: '1.0.0', to: '1.1.0', addedPermissions: [] }]);
  assert.equal(graph.resolve(refs.codexMods()).state.updatePolicy, 'auto');
  assert.deepEqual(graph.resolve(refs.codexMods()).links.update, refs.copyUpdate());
  const held = await graph.invoke({ ref: refs.copyUpdate(), operation: 'install', caller: USER, origin: 'app' });
  assert.deepEqual([held.status, held.reason], ['refused', 'notAllowed']);
  assert.match(held.message, /held: unit\.b: It needs the Select/);
  const stale = await graph.invoke({ ref: refs.copyUpdate(), operation: 'installAnyway', args: ['f'.repeat(32)], caller: USER, origin: 'app' });
  assert.equal(stale.reason, 'invalid');
  const anyway = await graph.invoke({ ref: refs.copyUpdate(), operation: 'installAnyway', args: ['e'.repeat(32)], caller: USER, origin: 'app' });
  assert.equal(anyway.status, 'done');
  assert.deepEqual(management.calls.filter((c) => c.method === 'updates.apply').map((c) => c.params), [{ plan: 'e'.repeat(32), anyway: true }]);
  // E6: apply names the plan seen, applies a held one only with anyway, and passes the mods consented to by id
  const notAnyway = await graph.invoke({ ref: refs.copyUpdate(), operation: 'apply', args: ['e'.repeat(32), false, []], caller: USER, origin: 'app' });
  assert.deepEqual([notAnyway.status, notAnyway.reason], ['refused', 'notAllowed']);
  const staleApply = await graph.invoke({ ref: refs.copyUpdate(), operation: 'apply', args: ['f'.repeat(32), true, []], caller: USER, origin: 'app' });
  assert.equal(staleApply.reason, 'invalid');
  const applied = await graph.invoke({ ref: refs.copyUpdate(), operation: 'apply', args: ['e'.repeat(32), true, [refs.mod('unit.a')]], caller: USER, origin: 'app' });
  assert.equal(applied.status, 'done');
  assert.deepEqual(management.calls.filter((c) => c.method === 'updates.apply').at(-1).params, { plan: 'e'.repeat(32), anyway: true, consent: ['unit.a'] });
  management.state.updates = { ...management.state.updates, offer: { ...management.state.updates.offer, dismissed: true },
    plan: { ...plan, consentNeeded: [{ id: 'unit.a', version: '1.1.0', addedPermissions: ['network'] }] } };
  await source.refresh(true);
  const later = graph.resolve(refs.copyUpdate());
  assert.equal(later.state.dismissed, true);
  assert.deepEqual(later.state.mods[0].addedPermissions, ['network'], 'the mods whose update asks more');
  for (const [operation, method] of [['download', 'updates.stage'], ['later', 'updates.later']]) {
    await graph.invoke({ ref: refs.copyUpdate(), operation, caller: USER, origin: 'app' });
    assert.ok(management.calls.some((c) => c.method === method), method);
  }
  await graph.invoke({ ref: refs.codexMods(), operation: 'setUpdatePolicy', args: ['offer'], caller: USER, origin: 'app' });
  assert.deepEqual(management.calls.find((c) => c.method === 'updates.policy').params, { policy: 'offer' });
  // E6: the user's order, every mod once, through management; a mod never sets it
  await graph.invoke({ ref: refs.codexMods(), operation: 'setModOrder', args: [[refs.mod('unit.b'), refs.mod('unit.a')]], caller: USER, origin: 'app' });
  assert.deepEqual(management.calls.find((c) => c.method === 'mods.order').params, { mods: ['unit.b', 'unit.a'] });
  assert.equal((await graph.invoke({ ref: refs.codexMods(), operation: 'setModOrder', args: [[refs.mod('unit.a')]], caller: mod('unit.a') })).status, 'refused');
  // a mod never applies the update
  const byMod = await graph.invoke({ ref: refs.copyUpdate(), operation: 'installAnyway', args: ['e'.repeat(32)], caller: mod('unit.a') });
  assert.equal(byMod.status, 'refused');
  // gone with its offer
  management.state.updates = { offer: null, plan: null };
  await source.refresh(true);
  assert.ok(!graph.resolve(refs.copyUpdate()) || graph.resolve(refs.copyUpdate()).gone);
});

test('F5: what a mod is now, the first that holds; a quarantine alone is not a stop; F6: what it says of itself', () => {
  const of = (o) => modStateOf({ status: 'enabled', compatibility: 'compatible', ...o });
  assert.equal(of({ reloading: true, status: 'quarantined', problem: 'x' }), 'reloading');
  assert.equal(of({ status: 'pendingConsent', compatibility: 'blocked', problem: 'x' }), 'consent');
  assert.equal(of({ consentRequest: { id: 'r' } }), 'consent', 'an update waiting is waiting for you too');
  assert.equal(of({ status: 'quarantined', problem: 'gone' }), 'missing');
  assert.equal(of({ status: 'quarantined', compatibility: 'blocked' }), 'incompatible');
  assert.equal(of({ compatibility: 'blocked' }), 'incompatible');
  assert.equal(of({ status: 'quarantined' }), 'stopped');
  assert.equal(of({ status: 'disabled' }), 'off');
  assert.equal(of({}), 'on');
  const detail = { id: 'm', name: 'M', version: '1', status: 'enabled', grants: [], installedAt: '2026-10-20T08:00:00.000Z',
    manifest: { author: 'Acme', glyph: 'bell', about: ['One.'], testedWith: ['26.1'], media: [{ id: 'a', src: 'media/a.png', caption: 'A', aspect: '1 / 1' }, { id: 'b', src: 'media/b.png' }] } };
  const s = modData(detail, null, null, null, undefined, [], null, { reloading: true, fresh: true }).state;
  assert.equal(s.state, 'reloading');
  assert.equal(s.new, true);
  assert.deepEqual([s.author, s.glyph, s.about, s.testedWith, s.installedAt], ['Acme', 'bell', ['One.'], ['26.1'], Date.parse('2026-10-20T08:00:00.000Z')]);
  assert.deepEqual(s.media, [{ id: 'a', caption: 'A', aspect: '1 / 1' }, { id: 'b' }], 'its paths stay inside the Host');
  const bare = modData({ id: 'm', name: 'M', version: '1', status: 'disabled', manifest: null, grants: [] }, null).state;
  assert.deepEqual([bare.state, bare.new, bare.about, bare.media, bare.testedWith], ['off', false, [], [], []]);
});

test('a mod an update left behind says so and why (E5)', () => {
  assert.deepEqual(reasonsOf({ status: 'compatible', missingRequired: [], missingOptional: [], reasons: [],
    leftBehind: { op: 'op-1', plan: 'p', at: '2026-10-28T02:44:00.000Z', why: ['It needs the Select.'] } }),
  ['The update of 2026-10-28 left it disabled: It needs the Select. Turn it on again when you want it.']);
});

test('E6: a Mod says whether it runs, its faults, the versions and data it can go back to, and what waits for its consent', async () => {
  const { graph, management, source } = await setup();
  const inspect = management.handle;
  const detail = {
    versions: [{ version: '0.9.0', rollback: { codeOnly: true, codeAndData: false } }, { version: '1.0.0', rollback: { codeOnly: false, codeAndData: false } }, { version: '0.8.0', rollback: { codeOnly: false, codeAndData: false } }],
    orphanedGenerations: [{ at: '2026-10-20T10:00:00.000Z-1', version: '0.9.0', bytes: 2048 }], dataBytes: 4096,
    storedOverrides: [{ key: 'mode', scope: 'thread:codex:t1', value: 'b', valid: true }, { key: 'gone', scope: 'project:codex:p%3A1', value: 1, valid: false }, { key: 'x', scope: 'bad', value: 1, valid: true }],
    consentRequest: { id: '0123456789abcdef', kind: 'update', version: '1.1.0', publisher: 'abcd1234abcd1234', permissions: ['graph.read:Thread', 'network'], addedPermissions: ['network'] },
  };
  management.handle = async (req) => {
    if (req.method === 'mods.inspect' && req.params.modId === 'unit.b') return { id: req.id, ok: false, error: { code: 'Unavailable', message: 'mods.inspect: its package is gone' } };
    const res = await inspect(req);
    if (req.method === 'mods.inspect') res.result = { ...res.result, ...detail };
    if (req.method === 'diagnostics') res.result = { ...res.result, mods: { 'unit.a': { status: 'enabled', runtime: 'active', faults: 2 } } };
    if (req.method === 'updates.status') res.result = { ...res.result, framework: { current: '0.9.0+abcd1234', previous: '0.8.0+00000000' }, lastCheck: { at: '2026-10-28T02:00:00.000Z' }, unknown: ['the release source cannot be reached.'] };
    return res;
  };
  management.emit({ event: 'mods', data: {} });
  await source.refresh(true);
  const a = graph.resolve(refs.mod('unit.a')).state;
  assert.deepEqual([a.running, a.faults, a.dataBytes], [true, 2, 4096]);
  assert.deepEqual(a.versions, [{ version: '0.9.0', codeOnly: true, withData: false }], 'only the kept versions it can go back to');
  assert.deepEqual(a.keptData, [{ generation: '2026-10-20T10:00:00.000Z-1', at: Date.parse('2026-10-20T10:00:00.000Z'), version: '0.9.0', bytes: 2048 }]);
  assert.deepEqual([a.consentRequest.id, a.consentRequest.kind, a.consentRequest.addedPermissions], ['0123456789abcdef', 'update', ['network']]);
  assert.equal(graph.resolve(refs.codexMods()).state.previousVersion, '0.8.0+00000000');
  // E6: the stored overrides as stored (a scope not in the graph is not seen), cleared by clear patches
  assert.deepEqual(a.storedOverrides, [
    { key: 'mode', kind: 'thread', scope: { type: 'Thread', provider: 'codex', id: 't1' }, value: 'b', seen: false, valid: true },
    { key: 'gone', kind: 'project', scope: { type: 'Project', provider: 'codex', id: 'p:1' }, value: 1, seen: false, valid: false }]);
  await graph.invoke({ ref: refs.mod('unit.a'), operation: 'clearOverrides', args: [[{ key: 'mode', scope: { type: 'Thread', provider: 'codex', id: 't1' } }]], caller: USER, origin: 'app' });
  assert.deepEqual(management.calls.filter((c) => c.method === 'mods.configure').at(-1).params, { modId: 'unit.a', patches: [{ key: 'mode', scope: 'thread:codex:t1', clear: true }] });
  await graph.invoke({ ref: refs.mod('unit.a'), operation: 'clearOverrides', caller: USER, origin: 'app' });
  assert.deepEqual(management.calls.filter((c) => c.method === 'mods.configure').at(-1).params.patches.map((p) => p.key), ['mode', 'gone'], 'all of them');
  assert.deepEqual([graph.resolve(refs.codexMods()).state.lastChecked, graph.resolve(refs.codexMods()).state.checkProblem], [Date.parse('2026-10-28T02:00:00.000Z'), 'the release source cannot be reached.']);
  // a mod whose package cannot be read is still a Mod, from its record, with its problem
  const b = graph.resolve(refs.mod('unit.b')).state;
  assert.deepEqual([b.status, b.running, b.version], ['disabled', false, '1.0.0']);
  assert.match(b.problem, /could not be read: .*package is gone/);
  // consent names the request reviewed; enable is passed when given
  await graph.invoke({ ref: refs.mod('unit.a'), operation: 'consent', args: ['0123456789abcdef', true], caller: USER, origin: 'app' });
  await graph.invoke({ ref: refs.mod('unit.a'), operation: 'consent', args: ['0123456789abcdef', true, true], caller: USER, origin: 'app' });
  assert.deepEqual(management.calls.filter((c) => c.method === 'mods.consent').map((c) => c.params), [
    { modId: 'unit.a', request: '0123456789abcdef', approve: true }, { modId: 'unit.a', request: '0123456789abcdef', approve: true, enable: true }]);
  // F8: the optional permissions allowed now go with consent
  await graph.invoke({ ref: refs.mod('unit.a'), operation: 'consent', args: ['0123456789abcdef', true, true, ['secrets']], caller: USER, origin: 'app' });
  assert.deepEqual(management.calls.filter((c) => c.method === 'mods.consent').at(-1).params, { modId: 'unit.a', request: '0123456789abcdef', approve: true, enable: true, allow: ['secrets'] });
  // install: a folder is a development package, only in Developer mode (F12, as the Host says it now); a file is a signed package
  const folder = fileURLToPath(new URL('.', import.meta.url));
  const refused = await graph.invoke({ ref: refs.codexMods(), operation: 'install', args: [folder], caller: USER, origin: 'app' });
  assert.deepEqual([refused.status, refused.reason, refused.message], ['refused', 'notAllowed', 'Turn on Developer mode to load a mod from a folder.']);
  assert.equal(graph.resolve(refs.codexMods()).state.developerMode, false);
  await graph.invoke({ ref: refs.codexMods(), operation: 'setDeveloperMode', args: [true], caller: USER, origin: 'app' });
  assert.equal(graph.resolve(refs.codexMods()).state.developerMode, true, 'read again');
  await graph.invoke({ ref: refs.codexMods(), operation: 'install', args: [folder], caller: USER, origin: 'app' });
  await graph.invoke({ ref: refs.codexMods(), operation: 'install', args: [fileURLToPath(import.meta.url)], caller: USER, origin: 'app' });
  assert.deepEqual(management.calls.filter((c) => c.method === 'mods.install').map((c) => c.params.dev ?? false), [true, false]);
  // F10: from GitHub, and an offered update applied
  await graph.invoke({ ref: refs.codexMods(), operation: 'installFromGitHub', args: ['acme/focus'], caller: USER, origin: 'app' });
  await graph.invoke({ ref: refs.mod('unit.a'), operation: 'applyUpdate', caller: USER, origin: 'app' });
  assert.deepEqual(management.calls.filter((c) => ['mods.installFromGitHub', 'mods.applyUpdate', 'framework.developerMode'].includes(c.method)).map((c) => [c.method, c.params]),
    [['framework.developerMode', { on: true }], ['mods.installFromGitHub', { repo: 'acme/focus' }], ['mods.applyUpdate', { modId: 'unit.a' }]]);
});

test('F10: Mod.source, a newer release found and why its last check could not complete, as the Host says them', () => {
  const base = { id: 'm', name: 'M', version: '1', status: 'enabled', manifest: {}, grants: [] };
  const digest = `sha256:${'a'.repeat(64)}`;
  const st = modData({ ...base, source: { kind: 'github', repo: 'acme/focus', repoId: 42, tag: 'v1', digest },
    release: { version: '2', notes: 'Faster.', addedPermissions: ['graph.read'], verdict: 'atRisk', publisherChange: false, repoChange: { from: 'acme/focus', to: 'acme/focus-mod' }, tag: 'v2' }, checkProblem: 'no network' }, null).state;
  assert.deepEqual(st.source, { kind: 'github', repo: 'acme/focus', tag: 'v1', digest }, 'its repository id is the Host\'s');
  assert.deepEqual(st.release, { version: '2', notes: 'Faster.', addedPermissions: ['graph.read'], verdict: 'atRisk', repoChange: { from: 'acme/focus', to: 'acme/focus-mod' } });
  assert.equal(st.checkProblem, 'no network');
  assert.deepEqual(modData({ ...base, source: { kind: 'folder', path: '/x' } }, null).state.source, { kind: 'folder', path: '/x' });
  assert.deepEqual(modData({ ...base, source: { kind: 'file' } }, null).state.source, { kind: 'file' });
  const plain = modData(base, null).state;
  assert.deepEqual([plain.source, plain.release, plain.checkProblem], [undefined, undefined, undefined]);
});

test('every operation the Host runs is an Operation of a declared kind (a switch of an automatic action or a policy too)', () => {
  const kinds = FRAMEWORK_TYPES.find((t) => t.id === 'Operation').spec.state.kind.schema.values;
  assert.deepEqual(Object.values(KIND).filter((k) => !kinds.includes(k)), []);
  for (const type of ['set-automatic', 'set-policy']) assert.ok(kinds.includes(operationData({ id: 'o', input: { type, modId: 'm' }, outcome: 'succeeded', startedAt: '2026-10-31T00:00:00Z' }).state.kind), type);
});

test('F11: the CopyUpdate says the step it prepares, the framework\'s support, whether it applies on its own, how its last try ended, and every mod\'s verdict', () => {
  const u = { offer: { id: 'o', build: '26.1017.2', copyBuild: '26.1016.1', framework: null, dismissed: false }, staging: { offer: 'o', step: 'mods' },
    support: { status: 'checking' }, auto: { will: false, why: 'tried' }, lastApply: { outcome: 'reverted', op: 'op-1', at: '2026-11-03T10:05:00.000Z', note: 'unhealthy' },
    plan: { hash: 'h', framework: null, mods: [], risks: [], held: false, display: [
      { id: 'a.one', version: '1.0.0', on: true, now: 'compatible', verdict: 'atRisk', unknown: false, tested: false, uses: [{ id: 'slot:composer', title: 'The composer' }, { id: 'graph:Thread', title: 'Threads' }], changed: ['slot:composer'], missing: ['graph:Thread'], unchecked: [],
        candidate: { version: '1.1.0', verdict: 'compatible', addedPermissions: ['secrets'], from: 'github' } }] } };
  const s = copyUpdateData(u).state;
  assert.deepEqual([s.step, s.support, s.automatic, s.lastApply], ['mods', { status: 'checking' }, { will: false, why: 'tried' }, { outcome: 'reverted', at: Date.parse('2026-11-03T10:05:00.000Z'), note: 'unhealthy' }]);
  assert.deepEqual(s.verdicts, [{ mod: refs.mod('a.one'), version: '1.0.0', on: true, now: 'compatible', after: 'atRisk', unknown: false, tested: false, uses: ['The composer', 'Threads'], changed: ['The composer'], missing: ['Threads'], unchecked: [],
    candidate: { version: '1.1.0', after: 'compatible', addedPermissions: ['secrets'], from: 'github' } }]);
  assert.equal(copyUpdateData({ offer: u.offer }).state.verdicts, undefined, 'none before a plan');
});

test('F13 and F15: Mod.places is its rules\' kind, presentation and slot, each once; whether its stop was looked at', () => {
  assert.deepEqual(placesOf([{ kind: 'add', presentation: 'Sidebar', slot: 'views', id: 'x' }, { kind: 'add', presentation: 'Sidebar', slot: 'views', id: 'y' }, { kind: 'decorate', presentation: 'SidebarItem' }, { nope: 1 }]),
    [{ kind: 'decorate', presentation: 'SidebarItem' }, { kind: 'add', presentation: 'Sidebar', slot: 'views' }], 'each once, in a stable order');
  const base = { id: 'm', name: 'M', version: '1', status: 'quarantined', manifest: {}, grants: [], quarantine: { reason: 'faults', at: '2026-11-03T10:00:00.000Z' } };
  assert.equal(modData(base, null).state.stopSeen, false);
  assert.equal(modData(base, null, null, null, undefined, [], null, { seenStop: Date.parse('2026-11-03T10:00:00.000Z') }).state.stopSeen, true);
  assert.equal(modData(base, null, null, null, undefined, [], null, { seenStop: Date.parse('2026-11-02T10:00:00.000Z') }).state.stopSeen, false, 'a later stop is not looked at');
  assert.equal(modData({ ...base, status: 'enabled', quarantine: null }, null).state.stopSeen, undefined);
  assert.deepEqual(modData(base, null, null, null, undefined, [], null, { places: [{ kind: 'style' }] }).state.places, [{ kind: 'style' }]);
});

test('F10: CodexMods.recommended is the catalog\'s well-formed entries, each with its repository; a malformed catalog gives none', () => {
  const repo = 'acme/mods';
  assert.deepEqual(recommendedOf({ repo, mods: [
    { id: 'acme.focus', name: 'Focus', description: 'One chat at a time', glyph: 'sparkle' },
    { id: 'Bad Id', name: 'X', description: 'y' },
    { id: 'acme.x', name: '', description: 'no name' },
    { id: 'acme.y', name: 'Y', description: 'z', glyph: 7 },
  ] }), [{ id: 'acme.focus', name: 'Focus', description: 'One chat at a time', glyph: 'sparkle', repo }]);
  for (const bad of [null, {}, { repo: '../x', mods: [] }, { repo, mods: 'no' }]) assert.deepEqual(recommendedOf(bad), [], JSON.stringify(bad));
});
