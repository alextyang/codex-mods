import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, crc32 } from 'node:zlib';
import { readZip, writeZip } from './zip.mjs';

const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

test('writeZip → readZip round-trips content, modes and directories', () => {
  const zip = writeZip([
    { path: 'mod.json', data: '{"a":1}' },
    { path: 'bin/run', data: Buffer.from([1, 2, 3]), mode: 0o755 },
    { path: 'empty/', directory: true },
    { path: 'ünï/cødé.txt', data: 'x' },
  ]);
  const out = readZip(zip);
  assert.deepEqual(out.map((e) => e.path), ['mod.json', 'bin/run', 'empty', 'ünï/cødé.txt']);
  assert.equal(out[0].data.toString(), '{"a":1}');
  assert.equal(out[1].mode, 0o755);
  assert.ok(out[2].directory);
});

test('writeZip is deterministic and stored-only', () => {
  const a = writeZip([{ path: 'x', data: 'hello' }]);
  assert.deepEqual(a, writeZip([{ path: 'x', data: 'hello' }]));
  assert.equal(a.readUInt16LE(8), 0); // method 0
  assert.equal(a.readUInt32LE(14), crc32(Buffer.from('hello')));
});

test('writeZip rejects absolute paths, .., backslashes, symlinks and duplicates', () => {
  for (const path of ['/etc/passwd', '../x', 'a/../b', 'a\\b', 'C:/x', 'a//b', './a']) {
    assert.equal(code(() => writeZip([{ path, data: 'x' }])), 'Invalid', path);
  }
  assert.equal(code(() => writeZip([{ path: 'l', data: 'x', symlink: true }])), 'Invalid');
  assert.equal(code(() => writeZip([{ path: 'l', data: 'x', mode: 0o120777 }])), 'Invalid');
  assert.equal(code(() => writeZip([{ path: 'a', data: '1' }, { path: 'a', data: '2' }])), 'Invalid');
  assert.equal(code(() => writeZip([{ path: 'a', data: '1' }, { path: 'A', data: '2' }])), 'Invalid');
});

// Hand-assemble archives the writer would never produce.
function rawZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const data = e.data ?? Buffer.alloc(0);
    const method = e.method ?? 0;
    const body = method === 8 ? deflateRawSync(data) : data;
    const crc = e.crc ?? crc32(data);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(0x800, 6); l.writeUInt16LE(method, 8);
    l.writeUInt32LE(crc, 14); l.writeUInt32LE(body.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE((3 << 8) | 20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8); c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38); c.writeUInt32LE(offset, 42);
    locals.push(l, name, body); centrals.push(c, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test('readZip reads deflate entries', () => {
  const data = Buffer.from('hello hello hello hello '.repeat(5));
  const out = readZip(rawZip([{ name: 'a.txt', data, method: 8 }]));
  assert.equal(out[0].data.toString(), data.toString());
});

test('readZip rejects hostile archives', () => {
  const d = Buffer.from('x');
  assert.equal(code(() => readZip(rawZip([{ name: '../evil', data: d }]))), 'Invalid');
  assert.equal(code(() => readZip(rawZip([{ name: '/abs', data: d }]))), 'Invalid');
  assert.equal(code(() => readZip(rawZip([{ name: 'a\\b', data: d }]))), 'Invalid');
  assert.equal(code(() => readZip(rawZip([{ name: 'link', data: d, mode: 0o120777 }]))), 'Invalid');
  assert.equal(code(() => readZip(rawZip([{ name: 'a', data: d }, { name: 'a', data: d }]))), 'Invalid');
  assert.equal(code(() => readZip(rawZip([{ name: 'a', data: d }, { name: 'A', data: d }]))), 'Invalid');
  assert.equal(code(() => readZip(rawZip([{ name: 'a', data: d, crc: 1234 }]))), 'Invalid');
  assert.equal(code(() => readZip(Buffer.from('not a zip at all, definitely'))), 'Invalid');
});

test('readZip enforces limits', () => {
  const zip = writeZip([{ path: 'a', data: 'x'.repeat(100) }, { path: 'b', data: 'y'.repeat(100) }]);
  assert.equal(code(() => readZip(zip, { maxEntries: 1 })), 'Invalid');
  assert.equal(code(() => readZip(zip, { maxFileBytes: 50 })), 'Invalid');
  assert.equal(code(() => readZip(zip, { maxTotalBytes: 150 })), 'Invalid');
  assert.equal(code(() => readZip(zip, { maxArchiveBytes: 10 })), 'Invalid');
  const bomb = rawZip([{ name: 'z', data: Buffer.alloc(1_000_000), method: 8 }]);
  assert.equal(code(() => readZip(bomb)), 'Invalid');
});
