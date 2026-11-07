// The framework's internal mods (framework/host/internal-mods.mjs; reference-mods.md §0, §2): read from framework/mods as the runtime
// activates them, granted what their manifests ask, their ids reserved against packages; a mod's service told who called it; a
// manifest's model use declared, checked and shown among its permissions without being granted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { internalMods, INTERNAL_MOD_IDS, hiddenRootOf } from '../internal-mods.mjs';
import { validateManifest } from '../packages/manifest.mjs';
import { createServiceRegistry, callerOf } from '../ctx/services.mjs';
import { permissionsOf } from '../graph/providers/framework/index.mjs';

const base = (o = {}) => ({ id: 'acme.writer', version: '1.0.0', name: 'Writer', framework: '>=1 <2', entry: { host: 'host.mjs' }, ...o });

test('the shipped internal mods are read as the runtime activates them, granted what they ask', () => {
  const layout = { data: '/p/data', retained: '/p/retained', backends: '/p/backends' };
  const mods = internalMods({ layout });
  assert.deepEqual(mods.map((m) => m.record.id), [...INTERNAL_MOD_IDS]);
  const [intel] = mods;
  assert.equal(intel.internal, true);
  assert.equal(intel.record.status, 'enabled');
  assert.deepEqual(intel.record.grants, intel.manifest.permissions);
  assert.equal(intel.dataDir, '/p/data/codexmods.intelligence');
  assert.equal(hiddenRootOf(intel.dataDir), '/p/data/codexmods.intelligence/threads');
});

test('a folder that is not an internal mod, or an invalid one, is skipped', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-internal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'acme.other'));
  writeFileSync(join(dir, 'acme.other', 'mod.json'), JSON.stringify(base({ id: 'acme.other' })));
  mkdirSync(join(dir, 'codexmods.intelligence'));
  writeFileSync(join(dir, 'codexmods.intelligence', 'mod.json'), '{ not json');
  const warned = [];
  assert.deepEqual(internalMods({ layout: { data: '/d', retained: '/r', backends: '/b' }, dir, log: { warn: (m) => warned.push(m) } }), []);
  assert.equal(warned.length, 1);
});

test('no package may take an internal mod\'s id; an internal manifest must be one', () => {
  assert.throws(() => validateManifest(base({ id: 'codexmods.intelligence' })), /the framework's internal mod/);
  assert.equal(validateManifest(base({ id: 'codexmods.intelligence' }), { internal: true }).id, 'codexmods.intelligence');
  assert.throws(() => validateManifest(base(), { internal: true }), /not an internal mod's id/);
});

test('model use is declared with why and the other tools it would like; shown among its permissions, never granted there', () => {
  const m = validateManifest(base({ intelligence: { why: 'It drafts notes', tools: ['web'] } }));
  assert.deepEqual(m.intelligence, { why: 'It drafts notes', tools: ['web'] });
  for (const [x, re] of [[{}, /intelligence\.why/], [{ why: ' ' }, /intelligence\.why/], [{ why: 'x', tools: ['shell'] }, /intelligence\.tools/],
    [{ why: 'x', tools: ['web', 'web'] }, /intelligence\.tools/], [{ why: 'x', extra: 1 }, /must be \{why, tools\?\}/], ['yes', /must be \{why, tools\?\}/]]) {
    assert.throws(() => validateManifest(base({ intelligence: x })), re, JSON.stringify(x));
  }
  const [p] = permissionsOf(m, []);
  assert.deepEqual([p.id, p.label, p.detail, p.granted, p.optional, p.risk], ['intelligence', 'Model use', 'It drafts notes', false, true, 'medium']);
  assert.match(p.text, /off until you turn it on on its page, and ask for web search there/);
});

test('a mod\'s service handler is told who called: a mod, a client holding a mod\'s lease, or the app', async () => {
  const services = createServiceRegistry();
  const seen = [];
  services.provide('acme.writer', 'svc', ['who'], 'host', 1, async (method, args, caller) => { seen.push(caller); return null; });
  await services.call('acme.writer', 'svc', 'who', null, 'mod:acme.reader');
  await services.call('acme.writer', 'svc', 'who', null, 'lease:mod:acme.writer');
  await services.call('acme.writer', 'svc', 'who', null, undefined);
  assert.deepEqual(seen, [{ kind: 'mod', id: 'acme.reader' }, { kind: 'client', mod: 'acme.writer' }, { kind: 'app' }]);
  assert.deepEqual(callerOf('framework'), { kind: 'app' });
});
