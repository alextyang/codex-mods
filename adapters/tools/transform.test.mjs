import test from 'node:test';
import assert from 'node:assert/strict';
import { fileStem, normalizeEditId, findMainBundle, isMandatoryTransformId, isMainBundle } from './transform.mjs';

test('fileStem: the name of a build file without directory, content hash and extension (the file\'s role)', () => {
  assert.equal(fileStem('.vite/build/main-CLu1A25j.js'), 'main');
  assert.equal(fileStem('.vite/build/src-DsLVGakC.js'), 'src');
  assert.equal(fileStem('.vite/build/worker.js'), 'worker');
  assert.equal(fileStem('webview/assets/app-initial-6350d04672d0.js'), 'app-initial');
  assert.equal(fileStem('.vite/build/main-Ab-d1234.js'), 'main', 'a base64url hash may contain a dash');
  assert.equal(fileStem('main'), 'main');
  assert.equal(fileStem('.vite/build/main.js'), 'main');
});

test('normalizeEditId: ids that embedded a chunk name are read by role; others are unchanged', () => {
  assert.equal(normalizeEditId('cua-bundle-id:main-CqEoQDOU.js:1'), 'cua-bundle-id:main:1');
  assert.equal(normalizeEditId('cua-bundle-id:src-BJv5Mk7n.js:1'), 'cua-bundle-id:src:1');
  assert.equal(normalizeEditId('cua-bundle-id:worker.js:1'), 'cua-bundle-id:worker:1');
  assert.equal(normalizeEditId('cua-bundle-id:main:3'), 'cua-bundle-id:main:3');
  for (const id of ['cua-container', 'cua-container:lib/node_modules/@oai/sky/x.js:1', 'keychain-service-name', 'managed-config-no-persist']) assert.equal(normalizeEditId(id), id);
  assert.ok(isMandatoryTransformId('cua-bundle-id:main:1') && isMandatoryTransformId('managed-config-no-persist') && !isMandatoryTransformId('trusted-view-sender'));
});

test('findMainBundle: exactly one .vite/build/main-*.js holds all anchors', () => {
  const files = { '.vite/build/main-AAAAAAAA.js': 'x one two', '.vite/build/main-BBBBBBBB.js': 'x one', '.vite/build/worker.js': 'one two', 'webview/assets/main-CCCCCCCC.js': 'one two' };
  const source = { list: (p) => Object.keys(files).filter((k) => k.startsWith(p)), read: (p) => files[p] };
  assert.equal(findMainBundle(source, ['one', 'two']).file, '.vite/build/main-AAAAAAAA.js');
  assert.match(findMainBundle(source, ['one']).error, /2 main bundles/);
  assert.match(findMainBundle(source, ['three']).error, /0 main bundles/);
  assert.ok(isMainBundle('.vite/build/main-AAAAAAAA.js') && !isMainBundle('.vite/build/worker.js') && !isMainBundle('webview/assets/main-CCCCCCCC.js'));
});
