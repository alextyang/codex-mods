// What a mod needs (docs/design/systems.md S18, "E4 in detail"): its features beside SDK v1's four lists read as mechanics, its typed
// grants as optional hints its own declarations win over, versions; the manifest's check of `features`; the answers by severity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { requirementsOf, computeCompatibility, atLeast, blockedBecause, noteOf } from '../compat.mjs';
import { validateManifest } from '../../packages/manifest.mjs';

const BASE = { id: 'unit.a', version: '1.0.0', name: 'A', framework: '>=1 <2', entry: { renderer: 'r.js' } };

test('requirements: methods and components as mechanics, features with their epochs, grants as optional hints; the mod\'s own required ones win', () => {
  const r = requirementsOf({
    requires: { methods: ['thread/start'], components: ['Button'], features: ['graph:Thread', { id: 'presentation:SidebarItem', version: 2 }] },
    optional: { methods: ['fs/copy'], features: ['graph:Thread'] },
    permissions: ['graph.read:Draft,Thread', 'graph.intercept:Thread.send', 'graph.present:SidebarItem', 'graph.read', 'ui'],
  });
  assert.deepEqual(r.required, [
    { id: 'protocol:thread/start', version: 1 },
    { id: 'sdk:component.Button', version: 1 }, { id: 'graph:Thread', version: 1 }, { id: 'presentation:SidebarItem', version: 2 },
  ]);
  assert.deepEqual(r.optional, [{ id: 'protocol:fs/copy', version: 1 }, { id: 'graph:Draft', version: 1 }, { id: 'graph:Thread.send', version: 1 }],
    'graph:Thread and presentation:SidebarItem are required; a bare grant names nothing');
});

test('the manifest\'s features: ids, or {id, version} with an epoch of at least 1, nothing else', () => {
  assert.deepEqual(validateManifest({ ...BASE, requires: { features: ['graph:Thread', { id: 'sdk:ui', version: 2 }] } }).requires.features, ['graph:Thread', { id: 'sdk:ui', version: 2 }]);
  for (const [features, re] of [['graph:Thread', /must be an array/], [['Thread'], /feature id/], [[{ id: 'graph:Thread', version: 0 }], /at least 1/],
    [[{ id: 'graph:Thread', why: 'x' }], /only id and version/]]) {
    assert.throws(() => validateManifest({ ...BASE, optional: { features } }), re);
  }
});

test('the answers by severity, and what the gates say', () => {
  assert.equal(atLeast('compatible', 'degraded'), 'degraded');
  assert.equal(atLeast('atRisk', 'degraded'), 'atRisk');
  assert.equal(atLeast('blocked', 'degraded'), 'blocked');
  const ev = { status: (id) => (id === 'service:gone' ? { status: 'missing', because: [{ id, status: 'missing', why: 'it is not in this build' }] }
    : id === 'service:dim' ? { status: 'unknown', because: [{ id, status: 'unknown', why: 'no census' }] } : { status: 'present', because: [] }) };
  const c = computeCompatibility({ requires: { features: ['service:gone', 'service:dim'] }, optional: { features: ['service:dim'] } }, { log: null, evaluation: ev });
  assert.equal(c.status, 'blocked');
  assert.equal(blockedBecause(c), 'It needs the app\'s gone service, which this build of the app lacks (it is not in this build).');
  const risky = computeCompatibility({ requires: { features: ['service:dim'] } }, { log: null, evaluation: ev });
  assert.equal(noteOf(risky), 'At risk: It needs the app\'s dim service, which could not be checked on this build of the app (no census).');
  assert.deepEqual(computeCompatibility({}, { log: null, evaluation: ev }), { status: 'compatible', missingRequired: [], missingOptional: [], reasons: [], features: [] });
});
