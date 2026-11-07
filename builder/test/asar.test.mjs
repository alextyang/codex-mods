import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AsarArchive, writeAsar, computeIntegrity, headerHash, BLOCK_SIZE } from '../asar.mjs';
import { makeAsar, tmpdir, sha } from './helpers.mjs';

const FILES = {
  'package.json': '{"main":"a.js"}\n',
  'a/b.js': 'console.log(1)',
  'a/c.js': { data: Buffer.from('exe'), executable: true },
  'z.txt': 'zzz',
  'empty1': '', 'empty2': '',
  'u/native.node': { unpacked: true, size: 8 },
};

test('index: list, stat, read, header hash', () => {
  const { buffer, headerString } = makeAsar(FILES, { reverseBody: true });
  const a = AsarArchive.fromBuffer(buffer);
  assert.equal(a.headerString, headerString);
  assert.equal(a.headerSha256, headerHash(headerString));
  assert.deepEqual(a.list().sort(), Object.keys(FILES).sort());
  assert.equal(a.read('a/b.js').toString(), 'console.log(1)');
  assert.equal(a.stat('a/c.js').executable, true);
  assert.equal(a.stat('u/native.node').unpacked, true);
  assert.equal(a.stat('a').type, 'directory');
  assert.equal(a.stat('nope'), null);
  assert.ok(a.verifyFile('z.txt'));
  assert.throws(() => a.read('a'), /no such file/);
});

test('round trip with no changes is byte-identical (non-monotonic offsets, shared empty files, unpacked entries)', (t) => {
  const dir = tmpdir(t);
  const { buffer } = makeAsar(FILES, { reverseBody: true });
  const src = path.join(dir, 'in.asar');
  fs.writeFileSync(src, buffer);
  const a = AsarArchive.open(src);
  const r = writeAsar(a, path.join(dir, 'out.asar'));
  a.close();
  assert.equal(r.changed, false);
  assert.equal(sha(fs.readFileSync(path.join(dir, 'out.asar'))), sha(buffer));
});

test('trailing bytes after the last body are preserved on a no-op rewrite', (t) => {
  const dir = tmpdir(t);
  const { buffer } = makeAsar(FILES);
  const padded = Buffer.concat([buffer, Buffer.from('TRAILER')]);
  const a = AsarArchive.fromBuffer(padded);
  writeAsar(a, path.join(dir, 'out.asar'));
  assert.equal(sha(fs.readFileSync(path.join(dir, 'out.asar'))), sha(padded));
});

test('replace and add: new contents readable, integrity valid, untouched files identical, header hash tracks', (t) => {
  const dir = tmpdir(t);
  const { buffer } = makeAsar(FILES, { reverseBody: true });
  const a = AsarArchive.fromBuffer(buffer);
  const big = Buffer.alloc(BLOCK_SIZE + 10, 9);
  const out = path.join(dir, 'out.asar');
  const r = writeAsar(a, out, {
    replace: new Map([['package.json', Buffer.from('{"main":"loader.cjs"}\n')], ['a/c.js', { data: Buffer.from('new'), executable: false }]]),
    add: new Map([['loader.cjs', Buffer.from('// loader\n')], ['deep/dir/big.bin', big]]),
  });
  assert.equal(r.changed, true);
  const b = AsarArchive.open(out);
  assert.equal(b.headerSha256, r.headerSha256);
  assert.equal(b.read('package.json').toString(), '{"main":"loader.cjs"}\n');
  assert.equal(b.read('loader.cjs').toString(), '// loader\n');
  assert.equal(b.read('deep/dir/big.bin').length, big.length);
  assert.equal(b.stat('deep/dir/big.bin').integrity.blocks.length, 2);
  assert.equal(b.stat('a/c.js').executable, false);
  for (const p of b.list()) if (!b.stat(p).unpacked) assert.ok(b.verifyFile(p), p);
  for (const p of ['a/b.js', 'z.txt', 'empty1']) assert.deepEqual(b.read(p), a.read(p));
  assert.deepEqual(b.stat('u/native.node'), a.stat('u/native.node'));
  b.close();
});

test('failure modes: replace missing / unpacked, add existing / under a file', () => {
  const a = AsarArchive.fromBuffer(makeAsar(FILES).buffer);
  const w = (o) => () => writeAsar(a, '/nonexistent-dir/out.asar', o);
  assert.throws(w({ replace: new Map([['nope', Buffer.from('x')]]) }), /no such file/);
  assert.throws(w({ replace: new Map([['u/native.node', Buffer.from('x')]]) }), /unpacked/);
  assert.throws(w({ add: new Map([['z.txt', Buffer.from('x')]]) }), /already exists/);
  assert.throws(w({ add: new Map([['z.txt/child', Buffer.from('x')]]) }), /parent is a file|Cannot|not/i);
});

test('computeIntegrity matches the stock shape', () => {
  assert.deepEqual(computeIntegrity(Buffer.alloc(0)), { algorithm: 'SHA256', hash: sha(Buffer.alloc(0)), blockSize: BLOCK_SIZE, blocks: [sha(Buffer.alloc(0))] });
  const i = computeIntegrity(Buffer.from('abc'));
  assert.equal(i.hash, sha('abc'));
  assert.deepEqual(i.blocks, [i.hash]);
});

test('not an asar', () => {
  assert.throws(() => AsarArchive.fromBuffer(Buffer.from('this is not an asar archive at all')), /ASAR/);
});
