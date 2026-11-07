// Minimal read-only Electron asar reader (Node built-ins only). Used by the adapter tools to inspect and
// extract stock files for hashing and static analysis. Never imported by product runtime code.
import { openSync, readSync, closeSync, mkdirSync, writeFileSync, fstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';

function readAt(fd, position, length) {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = readSync(fd, buf, got, length - got, position + got);
    if (n === 0) throw new Error(`asar: unexpected EOF at ${position + got}`);
    got += n;
  }
  return buf;
}

/** @returns {{ header: any, headerJson: string, headerSha256: string, contentOffset: number }} */
export function readAsarHeader(fd) {
  const head = readAt(fd, 0, 16);
  const pickleSize = head.readUInt32LE(4);           // bytes of the header pickle that follow offset 8
  const jsonLength = head.readUInt32LE(12);
  const json = readAt(fd, 16, jsonLength).toString('utf8');
  return {
    header: JSON.parse(json),
    headerJson: json,
    headerSha256: createHash('sha256').update(json).digest('hex'),
    contentOffset: 8 + pickleSize,
  };
}

/** Yield [path, entry] for every file in the header tree. */
export function* walk(node, prefix = '') {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (child.files) yield* walk(child, p);
    else yield [p, child];
  }
}

/** Open an archive. Returns {list(), read(path) → Buffer, headerSha256, close()}. */
export function openAsar(asarPath) {
  const fd = openSync(asarPath, 'r');
  const info = readAsarHeader(fd);
  const files = new Map(walk(info.header));
  return {
    headerSha256: info.headerSha256,
    size: fstatSync(fd).size,
    list: () => [...files.keys()],
    has: (p) => files.has(p),
    entry: (p) => files.get(p),
    read(path) {
      const e = files.get(path);
      if (!e) throw new Error(`asar: no such file ${path}`);
      if (e.unpacked) throw new Error(`asar: ${path} is unpacked`);
      return readAt(fd, info.contentOffset + Number(e.offset), e.size);
    },
    close: () => closeSync(fd),
  };
}

/** Extract every file whose path passes `filter` into outDir. Returns the extracted relative paths. */
export function extract(asarPath, outDir, filter = () => true) {
  const a = openAsar(asarPath);
  const out = [];
  try {
    for (const p of a.list()) {
      if (!filter(p) || a.entry(p).unpacked) continue;
      const dest = resolve(outDir, p);
      if (!dest.startsWith(resolve(outDir) + sep)) throw new Error(`asar: path escape ${p}`);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, a.read(p));
      out.push(p);
    }
  } finally { a.close(); }
  return out;
}
