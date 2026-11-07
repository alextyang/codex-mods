// Synthetic fixtures for builder tests: tiny asars, a fake Electron framework Mach-O, a fake stock app.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { computeIntegrity, frameHeader } from '../asar.mjs';
import { dictionaryDigest } from '../integrity.mjs';

export const sha = (b) => createHash('sha256').update(b).digest('hex');
export const tmpdir = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-builder-test-'));
  t?.after?.(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

/** Build an asar buffer. files: {path: Buffer|string|{data, executable}|{unpacked:true,size}}. Offsets are deliberately non-monotonic for entries listed in `shuffle`. */
export function makeAsar(files, { reverseBody = false } = {}) {
  const header = { files: {} };
  const entries = Object.entries(files);
  const bodies = [];
  let off = 0;
  const order = reverseBody ? [...entries].reverse() : entries;
  const offsets = new Map();
  for (const [p, v] of order) {
    if (v && v.unpacked) continue;
    const data = Buffer.isBuffer(v) ? v : typeof v === 'string' ? Buffer.from(v) : v.data;
    offsets.set(p, off); bodies.push(data); off += data.length;
  }
  for (const [p, v] of entries) {
    const parts = p.split('/');
    let dir = header;
    for (const part of parts.slice(0, -1)) dir = dir.files[part] ??= { files: {} };
    if (v && v.unpacked) { dir.files[parts.at(-1)] = { size: v.size, unpacked: true, integrity: computeIntegrity(Buffer.alloc(v.size)) }; continue; }
    const data = Buffer.isBuffer(v) ? v : typeof v === 'string' ? Buffer.from(v) : v.data;
    const node = { size: data.length, offset: String(offsets.get(p)), integrity: computeIntegrity(data) };
    if (v && v.executable) node.executable = true;
    dir.files[parts.at(-1)] = node;
  }
  const headerString = JSON.stringify(header);
  return { buffer: Buffer.concat([frameHeader(headerString), ...bodies]), headerString };
}

/** Minimal thin arm64 Mach-O with one __DATA_CONST,__asar_integrity section; returns {buffer, digestOffset}. */
export function makeFrameworkMachO({ digestHex, used = true, extraCopy = false }) {
  const cmdSize = 72 + 80;
  const dataOffset = 32 + cmdSize + 16;
  const total = dataOffset + 66 + 64;
  const b = Buffer.alloc(total);
  b.writeUInt32LE(0xfeedfacf, 0); b.writeUInt32LE(0x0100000c, 4); b.writeUInt32LE(6, 12); // MH_DYLIB
  b.writeUInt32LE(1, 16); b.writeUInt32LE(cmdSize, 20);
  b.writeUInt32LE(0x19, 32); b.writeUInt32LE(cmdSize, 36);
  b.write('__DATA_CONST', 40, 'ascii'); b.writeUInt32LE(1, 32 + 64);
  const s = 32 + 72;
  b.write('__asar_integrity', s, 'ascii'); b.write('__DATA_CONST', s + 16, 'ascii');
  b.writeBigUInt64LE(66n, s + 40); b.writeUInt32LE(dataOffset, s + 48);
  b.write('AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A', dataOffset, 'ascii');
  b[dataOffset + 32] = used ? 1 : 0; b[dataOffset + 33] = 1;
  Buffer.from(digestHex, 'hex').copy(b, dataOffset + 34);
  if (extraCopy) Buffer.from(digestHex, 'hex').copy(b, dataOffset + 66 + 8);
  return { buffer: b, digestOffset: dataOffset + 34 };
}

export function writePlist(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
  execFileSync('/usr/bin/plutil', ['-convert', 'xml1', file]);
}
export const readPlist = (file) => JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }));

export const PKG_MAIN = '.vite/build/main.js';
export const MAIN_JS = 'console.log("main");\nconst seam = 1;\n';

/**
 * A synthetic stock app. opts.framework: add Frameworks/Fake.framework/Fake with an integrity slot.
 * opts.realExe: use a copy of /usr/bin/true as the main executable (so real codesign works).
 * opts.asarFiles: more files inside app.asar ({path: Buffer|string}).
 */
export function makeStockApp(dir, opts = {}) {
  const app = path.join(dir, 'Stock.app');
  const contents = path.join(app, 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(contents, 'Resources', 'codex-cli', 'bin'), { recursive: true });
  const { buffer, headerString } = makeAsar({
    'package.json': JSON.stringify({ name: 'fixture', main: PKG_MAIN, version: '1.0.0' }, null, 2) + '\n',
    [PKG_MAIN]: MAIN_JS,
    'other/x.js': 'x',
    'empty-a.txt': '',
    'empty-b.txt': '',
    'native/n.node': { unpacked: true, size: 4 },
    ...(opts.asarFiles ?? {}),
  });
  fs.writeFileSync(path.join(contents, 'Resources', 'app.asar'), buffer);
  fs.mkdirSync(path.join(contents, 'Resources', 'app.asar.unpacked', 'native'), { recursive: true });
  fs.writeFileSync(path.join(contents, 'Resources', 'app.asar.unpacked', 'native', 'n.node'), Buffer.alloc(4));
  const integrity = { 'Resources/app.asar': { algorithm: 'SHA256', hash: sha(headerString) } };
  writePlist(path.join(contents, 'Info.plist'), {
    CFBundleIdentifier: 'com.example.stock', CFBundleName: 'Stock', CFBundleDisplayName: 'Stock', CFBundleExecutable: 'Stock',
    CFBundleShortVersionString: '1.2.3', CFBundleVersion: '45', CFBundlePackageType: 'APPL',
    CFBundleURLTypes: [{ CFBundleURLName: 'x', CFBundleURLSchemes: ['codex', 'https'] }], SUFeedURL: 'https://example.invalid/appcast.xml',
    CrProductDirName: 'com.example.stock', ElectronAsarIntegrity: integrity,
  });
  if (!opts.noOwl) fs.writeFileSync(path.join(contents, 'Resources', 'owl-app.ini'), '[Owl]\r\nUserDataDirectoryName=Codex\r\nAppVersion=1.2.3\r\n');
  if (opts.helper) {
    const hc = path.join(contents, 'Resources', 'cua_node', 'lib', 'node_modules', '@oai', 'sky', 'Codex Computer Use.app', 'Contents');
    writePlist(path.join(hc, 'Info.plist'), { CFBundleIdentifier: opts.helper === true ? 'com.openai.sky.CUAService' : opts.helper, CFBundleExecutable: 'SkyComputerUseService' });
    const nested = path.join(hc, 'SharedSupport', 'SkyComputerUseClient.app', 'Contents');
    writePlist(path.join(nested, 'Info.plist'), { CFBundleIdentifier: opts.helperNested ?? 'com.openai.sky.CUAService.Client' });
  }
  for (const [rel, data] of Object.entries(opts.extraFiles ?? {})) {
    fs.mkdirSync(path.dirname(path.join(contents, rel)), { recursive: true });
    fs.writeFileSync(path.join(contents, rel), data);
  }
  if (opts.realExe) fs.copyFileSync('/usr/bin/true', path.join(contents, 'MacOS', 'Stock'));
  else fs.writeFileSync(path.join(contents, 'MacOS', 'Stock'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(path.join(contents, 'MacOS', 'Stock'), 0o755);
  fs.writeFileSync(path.join(contents, 'CodeResources'), 'ticket');
  fs.writeFileSync(path.join(contents, 'embedded.provisionprofile'), 'profile');
  const codex = path.join(contents, 'Resources', 'codex-cli', 'bin', 'codex');
  fs.writeFileSync(codex, '#!/bin/sh\necho real-codex "$@"\n', { mode: 0o755 });
  let fwPath = null;
  if (opts.framework) {
    const fw = path.join(contents, 'Frameworks', 'Fake.framework');
    fs.mkdirSync(fw, { recursive: true });
    fwPath = path.join(fw, 'Fake');
    fs.writeFileSync(fwPath, makeFrameworkMachO({ digestHex: dictionaryDigest(integrity), ...opts.framework }).buffer);
  }
  return { app, contents, integrity, headerString, asarBuffer: buffer, fwPath, codexRel: 'Resources/codex-cli/bin/codex' };
}

export function makeBuildInputs(dir, { transforms = [], backend, extraAdapter = {}, sparkle = true } = {}) {
  const adapter = {
    adapterVersion: '0.0.1', build: { version: '1.2.3', bundleVersion: '45', asarSha256: null, electronVersion: '1' },
    backend: backend ?? { codexPath: 'Resources/codex-cli/bin/codex', method: 'replace' }, asarPackageJson: 'package.json',
    protocol: {}, transforms, anchors: {}, components: {}, react: null, theme: {}, actions: {}, ...extraAdapter,
  };
  const adapterPath = path.join(dir, 'adapter.json');
  fs.writeFileSync(adapterPath, JSON.stringify(adapter));
  const loader = path.join(dir, 'loader.cjs');
  fs.writeFileSync(loader, "const ROOT = '__CODEXMODS_ROOT__';\nglobalThis.__loaded = ROOT;\n" + (sparkle ? "process.env.CODEX_SPARKLE_ENABLED = 'false';\n" : ''));
  const relay = path.join(dir, 'relay.sh');
  fs.writeFileSync(relay, '#!/bin/sh\nexec "$0.real" "$@"\n', { mode: 0o755 });
  return { adapterPath, loader, relay };
}
