import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { createCodexmodResolver } = createRequire(import.meta.url)('./codexmod-protocol.cjs');
let tmp, pkg, r;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cm-proto-'));
  pkg = join(tmp, 'pkg'); mkdirSync(join(pkg, 'sub'), { recursive: true });
  writeFileSync(join(pkg, 'r.js'), 'js'); writeFileSync(join(pkg, 'sub', 'a b.css'), 'css'); writeFileSync(join(tmp, 'secret.txt'), 'secret');
  symlinkSync(join(tmp, 'secret.txt'), join(pkg, 'link.txt'));
  r = createCodexmodResolver();
  r.setModules([{ modId: 'acme.x', packageDir: pkg, entry: 'r.js', rev: 'r1' }]);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

test('serves files with mime types and CORS for the app origin', async () => {
  const js = await r.serve('codexmod://acme.x/r1/r.js');
  assert.equal(js.status, 200); assert.equal(String(js.body), 'js'); assert.match(js.headers['Content-Type'], /javascript/);
  assert.equal(js.headers['Access-Control-Allow-Origin'], 'app://-');
  const css = await r.serve('codexmod://acme.x/r1/sub/a%20b.css');
  assert.equal(css.status, 200); assert.match(css.headers['Content-Type'], /css/);
  const head = await r.serve('codexmod://acme.x/r1/r.js', 'HEAD');
  assert.equal(head.status, 200); assert.equal(head.body, null);
});

test('unknown modId, unknown rev, missing file, directory, and empty path are 404', () => {
  for (const u of ['codexmod://nope/r1/r.js', 'codexmod://acme.x/r2/r.js', 'codexmod://acme.x/r1/missing.js', 'codexmod://acme.x/r1/sub', 'codexmod://acme.x/r1/', 'codexmod://acme.x/r1', 'codexmod://acme.x/'])
    assert.equal(r.resolve(u).status, 404, u);
});

test('path escapes are refused: dot segments, encoded dots and slashes, backslashes, nul, symlinks leaving the package', () => {
  for (const u of ['codexmod://acme.x/r1/../secret.txt', 'codexmod://acme.x/r1/%2e%2e/secret.txt', 'codexmod://acme.x/r1/%2E%2E%2Fsecret.txt',
    'codexmod://acme.x/r1/sub/..%2F..%2Fsecret.txt', 'codexmod://acme.x/r1/..%5Csecret.txt', 'codexmod://acme.x/r1/r.js%00.png', 'codexmod://acme.x/r1/link.txt'])
    assert.notEqual(r.resolve(u).status, 200, u);
});

test('read-only: methods other than GET/HEAD are 405; bad URLs and foreign schemes do not serve', () => {
  assert.equal(r.resolve('codexmod://acme.x/r1/r.js', 'POST').status, 405);
  assert.equal(r.resolve('codexmod://acme.x/r1/r.js', 'PUT').status, 405);
  assert.equal(r.resolve('http://acme.x/r1/r.js').status, 404);
  assert.equal(r.resolve('not a url').status, 400);
  assert.equal(r.resolve('codexmod://acme.x/r1/%zz').status, 400);
});

test('setModules replaces the map; modId lookup ignores case', () => {
  assert.equal(r.resolve('codexmod://ACME.x/r1/r.js').status, 200);
  r.setModules([]);
  assert.equal(r.resolve('codexmod://acme.x/r1/r.js').status, 404);
});
