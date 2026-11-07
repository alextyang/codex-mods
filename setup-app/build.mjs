#!/usr/bin/env node
// Builds Codex Mods Setup.app (setup-app/README.md): the Swift window (mac/main.swift) for Apple silicon and Intel, and the framework tree it
// sets up from, as `codexmods setup` installs one (the framework, SDK, contracts, loader, relay, builder, CLI, adapter packs and mods, with
// no tests) plus this setup app's own page and server. Signed ad hoc unless an identity is given.
//
//   node setup-app/build.mjs [--source <tree>] [--out <dir>] [--identity <name|->] [--zip]
//
// `--source`: the tree to carry (a checkout, or the public tree); this checkout by default. `--zip`: also Codex-Mods-Setup.zip beside the
// app, for a release. Needs Xcode's command line tools. Node built-ins only.
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** What the app carries of the tree: what setup installs as the framework, and the setup app itself. */
export const CARRIED = Object.freeze(['framework', 'sdk', 'contracts', 'loader', 'relay', 'builder', 'cli', 'adapters', 'mods', 'package.json', 'setup-app']);
export const APP_NAME = 'Codex Mods Setup';

const run = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (e, out, err) => (e ? rej(new Error(`${cmd} ${args.join(' ')}\n${String(err || e.message).trim()}`)) : res(String(out)))));

/** Whether a path under the tree is carried: no tests, no git or editor files, no adapter tooling, not the app's own sources. */
export function carried(rel) {
  const parts = rel.split(sep);
  if (!CARRIED.includes(parts[0])) return false;
  if (parts.some((p) => p === '.git' || p === 'node_modules' || p === '.DS_Store' || p === 'test')) return false;
  if (rel.endsWith('.test.mjs')) return false;
  if (parts[0] === 'adapters' && parts[1] === 'tools') return false;
  if (parts[0] === 'contracts' && parts[1] === 'upstream') return false;
  if (parts[0] === 'setup-app' && (parts[1] === 'mac' || parts[1] === 'build.mjs')) return false;
  return true;
}

const plist = (o) => ['<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">', '<plist version="1.0">', '<dict>',
  ...Object.entries(o).flatMap(([k, v]) => [`\t<key>${k}</key>`, typeof v === 'boolean' ? `\t<${v}/>` : `\t<string>${String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>`]), '</dict>', '</plist>', ''].join('\n');

export async function buildApp({ source = resolve(HERE, '..'), out = join(resolve(HERE, '..'), '.tmp', 'setup-app'), identity = '-', zip = false } = {}) {
  const version = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).version;
  const app = join(out, `${APP_NAME}.app`);
  await rm(app, { recursive: true, force: true });
  const contents = join(app, 'Contents');
  await mkdir(join(contents, 'MacOS'), { recursive: true });
  await mkdir(join(contents, 'Resources'), { recursive: true });

  // the window, for both kinds of Mac
  const work = await mkdtemp(join(tmpdir(), 'codexmods-setup-'));
  try {
    const bins = [];
    for (const arch of ['arm64', 'x86_64']) {
      const bin = join(work, arch);
      await run('/usr/bin/xcrun', ['swiftc', '-O', '-swift-version', '5', '-target', `${arch}-apple-macos13.0`, '-o', bin, join(HERE, 'mac', 'main.swift'), '-framework', 'AppKit', '-framework', 'WebKit']);
      bins.push(bin);
    }
    await run('/usr/bin/lipo', ['-create', '-output', join(contents, 'MacOS', APP_NAME), ...bins]);
  } finally { await rm(work, { recursive: true, force: true }); }

  await writeFile(join(contents, 'Info.plist'), plist({
    CFBundleIdentifier: 'dev.codexmods.setup', CFBundleName: APP_NAME, CFBundleDisplayName: APP_NAME, CFBundleExecutable: APP_NAME,
    CFBundlePackageType: 'APPL', CFBundleShortVersionString: version, CFBundleVersion: version, LSMinimumSystemVersion: '13.0',
    NSHighResolutionCapable: true, LSApplicationCategoryType: 'public.app-category.developer-tools',
  }));

  // the tree it sets up from
  const tree = join(contents, 'Resources', 'codex-mods');
  for (const top of CARRIED) {
    await cp(join(source, top), join(tree, top), { recursive: true, filter: (p) => p === join(source, top) || carried(p.slice(source.length + 1)) }).catch((e) => { if (e.code !== 'ENOENT') throw e; });
  }

  await run('/usr/bin/codesign', ['--force', '--deep', '--sign', identity, app]);
  let zipped = null;
  if (zip) {
    zipped = join(out, 'Codex-Mods-Setup.zip');
    await rm(zipped, { force: true });
    await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zipped]);
  }
  return { app, zip: zipped, version };
}

async function main(argv) {
  const at = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const r = await buildApp({ ...(at('--source') ? { source: resolve(at('--source')) } : {}), ...(at('--out') ? { out: resolve(at('--out')) } : {}), ...(at('--identity') ? { identity: at('--identity') } : {}), zip: argv.includes('--zip') });
  process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e) => { process.stderr.write(`${e?.message ?? e}\n`); process.exitCode = 1; });
}
