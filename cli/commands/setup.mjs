// codexmods setup (ARCHITECTURE §14): installs the framework from this checkout, writes the profile, builds the first copy
// from the installed stock app and creates the stable launch symlink. Idempotent: a second run changes nothing.
//
//   codexmods setup [--identity <name|->] [--profile <name>] [--daily] [--root <dir>] [--app-path <path>] [--stock <app>]
import { cp, rename, rm, readFile, lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeJsonAtomic, readJson } from '../../framework/host/fsutil.mjs';
import { CodexModsError } from '../../sdk/errors.mjs';
import {
  FRAMEWORK_TREE, STOCK_APP, mkdirs, exists, readText, writeTextAtomic, readLinkAbs, replaceSymlinkAtomic, readAppBuildSync,
  frameworkVersionOf, installFrameworkTree, buildCandidate, runBuilderProcess, samePath,
} from '../../framework/host/recovery/support.mjs';
import { context, guarded, expandHome } from '../../framework/host/recovery/cli-common.mjs';

/** Apple Development identity of the installing person when one exists, else ad-hoc ('-'). Lists identities only. */
function detectIdentity() {
  return new Promise((res) => execFile('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], (e, out) => {
    const m = !e && /"(Apple Development:[^"]+)"/.exec(String(out));
    res(m ? m[1] : '-');
  }));
}

async function copyAdapterPacks(sourceRoot, layout) {
  const copied = [];
  let names;
  try { names = readdirSync(join(sourceRoot, 'adapters')); } catch { return copied; }
  for (const name of names.sort()) {
    if (name.startsWith('.') || name === 'tools') continue;
    const src = join(sourceRoot, 'adapters', name);
    if (!(await exists(join(src, 'adapter.json')))) continue;
    const dest = join(layout.adapters, name);
    const same = (await exists(join(dest, 'adapter.json')))
      && (await readFile(join(dest, 'adapter.json'))).equals(await readFile(join(src, 'adapter.json')));
    if (same) continue;
    const tmp = join(layout.adapters, `.setup-${randomBytes(4).toString('hex')}`);
    await cp(src, tmp, { recursive: true });
    await rm(dest, { recursive: true, force: true });
    await rename(tmp, dest);
    copied.push(name);
  }
  return copied;
}

export async function run(argv, io = {}) {
  let c;
  try { c = context(argv, io, { bool: ['daily', 'qa-no-restore', 'qa-socket-dirs'], value: ['identity', 'app-path', 'stock', 'source'] }); } catch (e) { (io.stderr ?? process.stderr).write(`${e.message}\n`); return 64; }
  return guarded(c, async () => {
    const { layout, flags, deps } = c;
    const sourceRoot = resolve(flags.source ?? deps.frameworkSource ?? FRAMEWORK_TREE);
    const summary = { root: layout.root, profile: layout.profile, steps: [] };
    const step = (name, detail) => { summary.steps.push({ step: name, ...detail }); };

    await mkdirs(layout.root, layout.framework, layout.adapters, layout.apps, layout.store, layout.profileDir, layout.userData,
      layout.ops, layout.generations, layout.data, layout.flags, layout.logs, layout.run);

    // profile.json: explicit flags override, everything else is preserved on a re-run
    const existing = await readJson(layout.profileConfig, undefined);
    // the stock app this profile's copies are built from (docs/design/systems.md E5): --stock records it, a re-run keeps it
    const stockApp = flags.stock ? resolve(expandHome(flags.stock, c.home)) : (existing?.stockApp ?? deps.stockApp ?? STOCK_APP);
    const identity = flags.identity ?? existing?.signingIdentity ?? await (deps.detectIdentity ?? detectIdentity)();
    const daily = flags.daily ? true : undefined;
    const isDaily = daily ?? (existing ? existing.codexHome === join(c.home, '.codex') : false);
    if (isDaily && flags['qa-no-restore']) throw new CodexModsError('Invalid', '--qa-no-restore is restricted to isolated QA profiles');
    if (isDaily && flags['qa-socket-dirs']) throw new CodexModsError('Invalid', '--qa-socket-dirs is restricted to isolated QA profiles');
    if (isDaily && identity === '-') {
      throw new CodexModsError('Invalid', 'a daily profile (shared ~/.codex) needs a real signing identity: ad-hoc ("-") copies cannot keep the Keychain grant or the stock helper separation. '
        + (flags.identity === '-' ? 'Pass an Apple Development identity with --identity "<name>".' : 'No Apple Development identity was found; pass one with --identity "<name>".'));
    }
    const profile = {
      codexHome: daily ? join(c.home, '.codex') : (existing?.codexHome ?? layout.codexHome),
      guardStockApp: daily ? true : (existing?.guardStockApp ?? false),
      signingIdentity: identity,
      appPath: resolve(expandHome(flags['app-path'] ?? existing?.appPath ?? join(c.home, 'Applications', 'ChatGPT Mods.app'), c.home)),
      // every (re)launch passes these after `open -n <appPath> --args` (v1.4): a QA profile keeps its own userData across app switches
      launchArgs: isDaily ? [] : (daily === undefined && Array.isArray(existing?.launchArgs) ? existing.launchArgs : [`--user-data-dir=${layout.userData}`]),
      ...(flags.stock ? { stockApp } : {}),
    };
    if (profile.codexHome === layout.codexHome) await mkdirs(layout.codexHome);
    // never clobber a real bundle at the stable path
    const st = await lstat(profile.appPath).catch(() => null);
    if (st && !st.isSymbolicLink()) throw new CodexModsError('Conflict', `${profile.appPath} exists and is not a symlink; choose another --app-path`);
    // setup owns only the fields above: everything else in profile.json (guardTrusted, future keys) is preserved as it is
    const merged = { ...(existing && typeof existing === 'object' ? existing : {}), ...profile };
    const changed = JSON.stringify(existing) !== JSON.stringify(merged);
    if (changed) await writeJsonAtomic(layout.profileConfig, merged);
    step('profile', { changed, codexHome: profile.codexHome, guardStockApp: profile.guardStockApp, identity, appPath: profile.appPath });

    // framework
    const version = await frameworkVersionOf(sourceRoot);
    const fwDir = join(layout.framework, version);
    const installed = !(await exists(join(fwDir, 'framework', 'main', 'index.cjs')));
    await installFrameworkTree(layout, sourceRoot, version);   // identical content reuses the immutable dir; a changed checkout has a new name
    const cur = await readText(layout.frameworkCurrent);
    if (cur !== version) {
      if (cur) await writeTextAtomic(layout.frameworkPrevious, cur);
      await writeTextAtomic(layout.frameworkCurrent, version);
    }
    if (!(await readText(layout.frameworkLkg)) || !cur) await writeTextAtomic(layout.frameworkLkg, version);
    step('framework', { version, installed, current: version });

    // adapter packs
    step('adapters', { copied: await copyAdapterPacks(sourceRoot, layout) });

    // first copy from the installed stock app
    const stock = (deps.readBuild ?? readAppBuildSync)(stockApp);
    const adapterPath = join(layout.adapters, stock.build, 'adapter.json');
    if (!(await exists(adapterPath))) {
      throw new CodexModsError('Incompatible', `no adapter pack for the installed ChatGPT build ${stock.build}; the framework is installed. `
        + 'Run `codexmods app prepare` from a running copy of an older build, or add the pack under adapters/.');
    }
    const previousCandidate = readLinkAbs(profile.appPath) ?? undefined;
    const built = await buildCandidate({ layout, profile, stockApp, build: stock.build, adapterPath, frameworkDir: fwDir, frameworkVersion: version,
      runBuilder: deps.runBuilder ?? ((args) => runBuilderProcess(args)), inUse: async () => false, previousCandidate,
      // a daily copy must carry a real identity (the builder suppresses the updater by default since v1.14; --allow-updater is the escape)
      extraArgs: isDaily ? ['--require-identity'] : ['qa-no-restore', 'qa-socket-dirs'].filter((f) => flags[f]).map((f) => `--${f}`) });
    step('copy', { build: stock.build, candidate: built.candidate, reused: built.reused, inputsHash: built.inputsHash, triggers: built.triggers });

    // stable symlink and apps/lkg
    let link = readLinkAbs(profile.appPath);
    let repointed = null, notSelected = null;
    if (!link) { await replaceSymlinkAtomic(profile.appPath, built.candidate); link = built.candidate; }
    else if (!(await samePath(link, built.candidate))) {
      if (isDaily) {
        // never silently keep a daily launch path on an older candidate: switch it atomically and say so
        await replaceSymlinkAtomic(profile.appPath, built.candidate);
        repointed = { from: link, to: built.candidate }; link = built.candidate;
      } else notSelected = built.candidate;
    }
    step('stable-path', { appPath: profile.appPath, target: link, ...(repointed ? { repointed } : {}), ...(notSelected ? { notSelected } : {}) });
    if (!(await readText(layout.lkgApp))) await writeTextAtomic(layout.lkgApp, link);

    c.print([`codexmods is set up at ${layout.root} (profile ${layout.profile}).`,
      `  framework ${version}${installed ? ' installed' : ' already installed'}`,
      `  copy ${built.candidate}${built.reused ? ' (already built)' : ''}`,
      ...(built.reused ? [] : [built.triggers[0] === 'first build' ? '  built: first build' : `  rebuilt because: ${built.triggers.length ? built.triggers.map((x) => `${x} changed`).join(', ') : 'inputs differ from the selected copy'}`]),
      `  launch path ${profile.appPath} -> ${link}`,
      ...(repointed ? [`  launch path repointed: ${repointed.from} -> ${repointed.to}`] : []),
      ...(notSelected ? [`  the launch path still points at the older copy; ${notSelected} is built but not selected (use \`codexmods app apply\`)`] : [])].join('\n'), summary);
    return 0;
  });
}
