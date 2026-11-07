// A build's status in the feature log (docs/design/systems.md S17, "E4 in detail"): each kind's rule for present, changed, missing and
// unknown; live evidence only raising (or a trip making a binding changed); a feature the worst of its needs, alternatives the best, a
// concept the best of its realizations; the census diff and the comparison of two builds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { judge, evaluate, diffFacts, affected, mergeLive, liveOfProbe, causeOf } from '../status.mjs';
import { createFeatureState } from '../evidence.mjs';

const ok = (values, extra = {}) => ({ status: 'ok', values, digestSha256: values.join('|'), ...extra });
const LOG = {
  reference: {
    protocol: { 'thread/read': { in: 'schema', fp: ['aa'] }, 'thread/gone': { in: 'schema', fp: ['bb'] }, 'thread/rollback': { in: 'wireOnly', fp: [] } },
    bindings: { 'sidebar.item': 'objects', 'turn.view': 'jsx' },
  },
  mechanics: {
    'binding:turn.view': { needs: ['seam:jsx'] }, 'binding:sidebar.item': { needs: ['seam:jsx'] },
    'binding:settings.navgroup': { needs: ['seam:jsx', 'exposure:NavGroup'], keyless: true },
  },
  features: {
    'graph:Thread': { title: 'the Thread type', realizedBy: ['graph:CodexThread'] },
    'graph:CodexThread': { title: 'the CodexThread type', needs: ['protocol:thread/read', 'service:pinnedThreads'], prefers: ['protocol:thread/rollback'] },
    'graph:Thread.rename': { title: 'the Thread.rename operation', needs: ['graph:Thread', 'protocol:thread/name/set'] },
    'graph:Account': { title: 'the Account type', needs: [{ anyOf: ['service:accountInfo', 'service:accessInputs'] }] },
  },
};
function evidence(over = {}) {
  return {
    build: '1-1',
    pack: { build: { version: '1', bundleVersion: '1' }, protocol: { methods: { clientRequests: ['thread/read'] } }, anchors: { sidebar: {}, composer: {} },
      seams: { hooks: { jsx: 'jsx-seam', taps: ['a', 'b', 'c'], menuItems: null, exposures: { react: 'x', NavGroup: 'y' } } } },
    facts: { families: {
      'protocol.schema': ok(['ClientRequest:thread/read', 'ClientRequest:thread/name/set', 'ClientRequest:queue/add'], { fingerprints: { 'ClientRequest:thread/read': 'aa', 'ClientRequest:thread/name/set': 'nn', 'ClientRequest:queue/add': 'qq' } }),
      'protocol.wireOnly': ok(['thread/rollback']),
      'apphost.services': ok(['pinnedThreads', 'accessInputs'], { parts: { literalKeys: 2 } }),
      'routes.paths': ok(['/', '/settings/:slug'], { unresolved: ['e'] }),
      'commands.ids': ok(['composer.submit'], { unresolvedElements: 0, unresolved: 0 }),
      'bus.fromView': ok(['open-in-new-window']),
      'bindings.sites': ok(['sidebar.item', 'turn.view'], { sites: { 'sidebar.item': { jsx: 0, objects: 1 }, 'turn.view': { jsx: 1, objects: 0 }, 'thread.view': { jsx: 0, objects: 1 } }, addressesSha256: 'A' }),
    } },
    report: { to: '1-1', protocol: { regenerated: true }, anchors: { sidebar: { selectors: [{ status: 'found' }] }, composer: { selectors: [{ status: 'missed' }] } } },
    stale: [], addressesSha256: 'A', live: null, ...over,
  };
}
const s = (id, ev = evidence(), log = LOG) => judge(id, ev, log).status;

test('protocol: in the schema (fingerprint a reference had), changed, missing only when a reference schema had it, wire-only, no census', () => {
  assert.equal(s('protocol:thread/read'), 'present');
  assert.equal(s('protocol:queue/add'), 'present', 'an experimental-only method a mod or the framework uses: the schema has it');
  const changed = evidence(); changed.facts.families['protocol.schema'].fingerprints['ClientRequest:thread/read'] = 'zz';
  assert.equal(s('protocol:thread/read', changed), 'changed');
  assert.equal(s('protocol:thread/gone'), 'missing', 'the reference builds\' schema had it, this regenerated schema does not');
  assert.equal(s('protocol:fs/copy'), 'unknown', 'a method no reference had and the schema lacks may be wire-only');
  assert.equal(s('protocol:thread/rollback'), 'present', 'among the wire-only methods');
  assert.equal(s('protocol:thread/read', evidence({ report: { to: '1-1', protocol: { regenerated: false } } })), 'unknown', 'a carried-over catalog');
  assert.equal(s('protocol:thread/read', evidence({ facts: null })), 'present', 'no census: the pack\'s catalog');
  assert.equal(s('protocol:queue/add', evidence({ facts: null })), 'unknown');
  assert.equal(s('protocol:thread/read', evidence({ stale: ['census'] })), 'unknown', 'another build\'s census');
});

test('census kinds: present, missing only by a complete family, unknown when partial, absent or stale', () => {
  assert.equal(s('service:pinnedThreads'), 'present');
  assert.equal(s('service:gitRepository'), 'missing', 'the services family resolved everything');
  assert.equal(s('route:/nowhere'), 'unknown', 'the routes family left entries unresolved');
  assert.equal(s('route:/settings/'), 'present', 'a path\'s prefix');
  assert.equal(s('command:composer.submit'), 'present');
  assert.equal(s('command:composer.clear'), 'missing');
  assert.equal(s('message:run-command'), 'unknown', 'its family did not run');
  assert.equal(s('fromView:open-in-new-window'), 'present', 'a message the app\'s main takes from its pages');
  assert.equal(s('fromView:open-somewhere'), 'missing');
  assert.equal(s('service:pinnedThreads', evidence({ facts: null })), 'unknown');
  assert.equal(s('service:pinnedThreads', evidence({ stale: ['census'] })), 'unknown');
});

test('seams and exposures: present only when the copy delivers them; a locator miss is unknown, never missing', () => {
  assert.equal(s('seam:jsx'), 'present');
  assert.equal(s('seam:taps'), 'present');
  assert.equal(s('seam:menuItems'), 'unknown');
  assert.equal(s('exposure:react'), 'present');
  assert.equal(s('exposure:ComposerDropdown'), 'unknown');
});

test('bindings: their needs delivered and their address found no weaker than on the references; live trips and sightings', () => {
  assert.equal(s('binding:turn.view'), 'present', 'a JSX call site');
  assert.equal(s('binding:sidebar.item'), 'present', 'an object literal, as on the references');
  assert.equal(s('binding:thread.view'), 'unknown', 'only an object literal, where the references were not that weak');
  assert.equal(s('binding:settings.navgroup'), 'present', 'addressed by its exposure');
  const noJsx = evidence(); noJsx.pack.seams.hooks.jsx = null;
  assert.equal(judge('binding:turn.view', noJsx, LOG).why, 'the copy does not deliver jsx');
  assert.equal(s('binding:turn.view', evidence({ addressesSha256: 'B' })), 'unknown', 'a census of other addresses');
  assert.equal(s('binding:thread.view', evidence({ live: { bindings: { 'thread.view': { state: 'works' } } } })), 'present', 'a window saw it');
  const tripped = judge('binding:turn.view', evidence({ live: { bindings: { 'turn.view': { state: 'tripped', why: 'its canary failed: turnId is null' } } } }), LOG);
  assert.deepEqual(tripped, { status: 'changed', why: 'its canary tripped: its canary failed: turnId is null' });
});

test('anchors: the pack enumerates them; selectors verified or a window\'s sighting make one present', () => {
  assert.equal(s('anchor:sidebar'), 'present', 'its selector was found');
  assert.equal(s('anchor:composer'), 'unknown', 'declared, not verified, not seen: no longer missing');
  assert.equal(s('anchor:composer', evidence({ live: { anchors: ['composer'] } })), 'present');
  assert.equal(s('anchor:statusbar'), 'missing', 'the pack has no such anchor');
});

test('features: the worst of their needs, alternatives the best, a concept the best of its realizations, prefers never count', () => {
  const ev = evaluate(LOG, evidence());
  assert.equal(ev.features['graph:CodexThread'].status, 'present', 'thread/rollback is only preferred');
  assert.equal(ev.features['graph:Thread'].status, 'present');
  assert.equal(ev.features['graph:Account'].status, 'present', 'one of the alternatives is there');
  const gone = evidence(); gone.facts.families['apphost.services'].values = ['accessInputs'];
  const ev2 = evaluate(LOG, gone);
  assert.equal(ev2.features['graph:CodexThread'].status, 'missing');
  assert.equal(ev2.features['graph:Thread'].status, 'missing', 'its only realization');
  assert.equal(ev2.features['graph:Thread.rename'].status, 'missing', 'it needs its type');
  assert.deepEqual(causeOf(ev2.status('graph:Thread.rename')), { id: 'service:pinnedThreads', status: 'missing', why: 'it is not in this build' });
  assert.equal(ev2.status('graph:Nope').status, 'unknown', 'an id the log does not have');
  assert.equal(ev2.status('service:gitRepository').status, 'missing', 'any mechanic id is judged by its kind');
});

test('the census diff and two builds\' comparison name what moved, including a new reason under the same status', () => {
  const a = evidence(), b = evidence();
  b.facts.families['apphost.services'] = ok(['pinnedThreads', 'gitRepository']);
  b.facts.families['protocol.schema'].fingerprints['ClientRequest:queue/add'] = 'q2';
  const d = diffFacts(a.facts, b.facts);
  assert.deepEqual(d['apphost.services'], { appeared: ['gitRepository'], disappeared: ['accessInputs'] });
  assert.deepEqual(d['protocol.schema'].changed, ['ClientRequest:queue/add']);
  assert.equal(d['routes.paths'], undefined, 'unchanged families are left out');
  const x = evaluate(LOG, a), y = evaluate(LOG, b);
  assert.ok(affected(x, y).some((r) => r.id === 'service:accessInputs' && r.from === 'present' && r.to === 'missing'));
  const c = evidence(); c.facts.families['protocol.schema'].fingerprints['ClientRequest:thread/read'] = 'z1';
  const e = evidence(); e.facts.families['protocol.schema'].fingerprints['ClientRequest:thread/read'] = 'z2';
  assert.equal(affected(evaluate(LOG, c), evaluate(LOG, e)).length, 0, 'the same status and reason: nothing to tell');
});

test('live evidence across windows: a trip in any live window wins; anchors seen anywhere; the probe state read', () => {
  const m = mergeLive([{ bindings: { a: { state: 'works' }, b: { state: 'works' } } }, { bindings: { a: { state: 'tripped', why: 'x' }, c: { state: 'unseen' } }, anchors: ['sidebar'] }]);
  assert.deepEqual(m, { bindings: { a: { state: 'tripped', why: 'x' }, b: { state: 'works' }, c: { state: 'unseen' } }, anchors: ['sidebar'] });
  assert.deepEqual(liveOfProbe({ items: { 'anchor:sidebar': true, 'anchor:composer': false, 'binding:x': true }, bindings: { x: { state: 'works' } } }),
    { bindings: { x: { state: 'works' } }, anchors: ['sidebar'] });
});

test('the running copy\'s state: what the windows saw changes the evaluation; a method the providers request that the log lacks is named once', async () => {
  const pack = evidence().pack;
  const st = await createFeatureState({ log: LOG, pack, dirs: [] });
  assert.equal(st.current().status('binding:thread.view').status, 'unknown', 'no census, nothing seen');
  let changed = 0;
  st.onChange(() => changed++);
  st.setLive({ bindings: { 'thread.view': { state: 'works' } }, anchors: [] });
  st.setLive({ bindings: { 'thread.view': { state: 'works' } }, anchors: [] });
  assert.equal(changed, 1, 'the same report again changes nothing');
  assert.equal(st.current().status('binding:thread.view').status, 'present');
  const logged = await createFeatureState({ log: { ...LOG, mechanics: { ...LOG.mechanics, 'protocol:thread/read': {} } }, pack, dirs: [] });
  assert.equal(logged.noteRequested('thread/read'), false, 'in the log');
  assert.deepEqual([logged.noteRequested('thread/fresh'), logged.noteRequested('thread/fresh')], [true, false], 'named once');
  assert.deepEqual(logged.unlogged(), ['thread/fresh']);
});
