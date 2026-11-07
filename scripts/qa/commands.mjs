// Impure QA commands. Everything that talks to the system goes through `sys` so tests could inject fakes;
// the pure decisions live in args/procs/isolation/readiness.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SOCKETS } from '../../contracts/layout.mjs';
import { connectHost, HostNotRunning } from '../../cli/lib/client.mjs';
import { qaPaths, buildOpenArgs, planRebuildDir, protectedAppDirs, supersededCopies, supersededFrameworks, MOCK_KEYCHAIN_SWITCH } from './args.mjs';
import { outsideHarness, suppressRestoration, qaPreferences, restorationInstruction, COPY_BUNDLE_ID } from './restoration.mjs';
import { updaterViolations } from './updater.mjs';
import { classifyGuardFixtures, withoutFixtures } from './guard.mjs';
import { parsePs, ownedProcesses, family, findMain, roleOf, selfAndAncestors, signalTargets, modCopyRunning, copyTempFiles } from './procs.mjs';
import { evaluateIsolation, parseLsofF } from './isolation.mjs';
import { evaluateReadiness, planLateChecks } from './readiness.mjs';
import { ensureTomlBool, removeTomlKeyLines, tomlStringValue } from './toml.mjs';
import { classifyHelper, isRelevantFile } from './helper.mjs';
import { logShowArgs, parsePromptLog, matchPrompts, dismissSecurityAgents, EXIT_PROMPT, ERROR_PROMPT } from './keychain.mjs';

const CHECKOUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(CHECKOUT, 'cli', 'codexmods.mjs');
/** The QA-only build policy every QA copy is built with: no AppKit restoration, main's /tmp socket directories in the profile (N8). */
export const QA_BUILD_POLICY = Object.freeze(['--qa-no-restore', '--qa-socket-dirs']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); const t = `${f}.tmp-${process.pid}`; fs.writeFileSync(t, `${JSON.stringify(v, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(t, f); };

export const sys = {
  // only this user's processes: another user's ssh client or shell can carry the QA root in its command line, and must never be signalled
  ps: () => parsePs(spawnSync('/bin/ps', ['-U', String(process.getuid()), '-o', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).stdout),
  // inspection commands return the full result: the caller decides, nothing is discarded here
  psEnv: (pid) => spawnSync('/bin/ps', ['eww', '-p', String(pid)], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }),
  lsof: (pids) => spawnSync('/usr/sbin/lsof', ['-p', pids.join(','), '-Fpn'], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }),
  kill: (pid, sig) => { try { process.kill(pid, sig); return true; } catch { return false; } },
  run: (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts }),
  // absolute path: `log` is a zsh builtin, and PATH must not matter
  logShow: (args) => spawnSync('/usr/bin/log', args, { encoding: 'utf8', timeout: 90000, maxBuffer: 64 * 1024 * 1024 }),
};

const rootsOf = (root) => { const s = new Set([root]); try { s.add(fs.realpathSync(root)); } catch { /* not created yet */ } return [...s]; };
const launchFile = (root) => path.join(qaPaths(root).qaDir, 'harness-launch.json');
const restorePolicy = (root) => suppressRestoration({ roots: rootsOf(root), preferences: sys.preferences ?? qaPreferences((...a) => sys.run(...a)) });
const unmanaged = (root, processes) => outsideHarness(processes, readJson(launchFile(root)), (pid) => sys.psEnv(pid)?.stdout);
const fixtureFile = (root) => path.join(qaPaths(root).qaDir, 'guard-fixture.json');
const readFixtures = (root) => readJson(fixtureFile(root))?.fixtures ?? [];
function owned(root) {
  const rows = sys.ps();
  // `--guard` fixtures (a CLI app-server started by the tester on the QA codex-home) are outside the ownership checks
  return { rows, list: withoutFixtures(ownedProcesses(rows, rootsOf(root), selfAndAncestors(rows, process.pid)), readFixtures(root)) };
}

// ----------------------------------------------------------------------------------------------- setup
const DIAG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'diag');
export function diagPrelude({ full, control }) {
  return fs.readFileSync(path.join(DIAG_DIR, 'prelude.cjs'), 'utf8').replace('__DIAG_FULL__', String(!!full)).replace('__DIAG_CONTROL__', String(!!control))
    .replace('__TAP_SOURCE__', () => JSON.stringify(fs.readFileSync(path.join(DIAG_DIR, 'tap.mjs'), 'utf8')));
}
const SOURCE_ALLOW = ['framework', 'sdk', 'contracts', 'loader', 'relay', 'builder', 'cli', 'adapters', 'mods', 'package.json'];
const PROBE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'probe');
/** A copy of this checkout whose loader has the observation prelude and/or a probe prepended: the --source of a diagnostic setup. */
function makeDiagSource(root, { diag = true, probe = null } = {}) {
  const dest = path.join(root, 'qa', 'diag-src');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const name of SOURCE_ALLOW) {
    fs.cpSync(path.join(CHECKOUT, name), path.join(dest, name), { recursive: true, filter: (s) => !/(^|\/)(\.git|node_modules|\.DS_Store)(\/|$)/.test(s) && !s.endsWith('.test.mjs') });
  }
  const loader = path.join(dest, 'loader', 'loader.cjs');
  const preludes = [diag ? diagPrelude({ full: true }) : '', probe ? fs.readFileSync(path.join(PROBE_DIR, `${probe}.cjs`), 'utf8') : ''].filter(Boolean);
  fs.writeFileSync(loader, `${preludes.join('\n')}\n${fs.readFileSync(loader, 'utf8')}`);
  if (!diag) return dest;
  // protocol tap: tee both directions of every relay to <root>/qa/relay-<pid>.{app-to-host,host-to-app} (diagnostic builds only)
  const relay = path.join(dest, 'relay', 'relay');
  let text = fs.readFileSync(relay, 'utf8');
  const a = '( printf \'%s\\n\' "$header"; exec cat <&3 ) > "$fifo" &';
  const b = '/usr/bin/nc -U "$sock" < "$fifo"\nexit $?';
  if (!text.includes(a) || !text.includes(b)) throw new Error('relay/relay changed: update the diagnostic tap in scripts/qa/commands.mjs');
  text = text.replace(a, () => 'qa="$CODEX_MODS_RUN_DIR/../../../qa"; ( printf \'%s\\n\' "$header"; exec tee "$qa/relay-$$.app-to-host" <&3 ) > "$fifo" &')
    .replace(b, () => '/usr/bin/nc -U "$sock" < "$fifo" | tee "$qa/relay-$$.host-to-app"\nexit 0');
  const anchor = 'real="${CODEX_MODS_REAL_CODEX:-$0.real}"\n';
  if (!text.includes(anchor)) throw new Error('relay/relay changed: update the diagnostic argv log in scripts/qa/commands.mjs');
  text = text.replace(anchor, () => `${anchor}[ -n "\${CODEX_MODS_RUN_DIR:-}" ] && echo "$$ $*" >> "$CODEX_MODS_RUN_DIR/../../../qa/relay-argv.log"\n`);
  fs.writeFileSync(relay, text, { mode: 0o755 });
  return dest;
}

export async function setup({ root, diag = false, probe = null, identity = null, stock = null, rebuild = false }) {
  const P = qaPaths(root);
  // Keep the profile's identity unless one is given: a team-signed QA copy must not fall back to ad-hoc on a plain rebuild, because the
  // owner's Computer Use grants follow the team identity (an ad-hoc build would need them again).
  identity = identity ?? readJson(P.layout.profileConfig)?.signingIdentity ?? '-';
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(P.qaDir, { recursive: true, mode: 0o700 });
  const t0 = Date.now();
  // A team identity comes from the QA user's dedicated signing keychain (scripts/qa/signing-keychain.sh), unlocked without a password,
  // so codesign never shows a dialog. Ad-hoc ('-') needs no keychain.
  if (identity !== '-') {
    const kc = path.join(os.homedir(), 'Library', 'Keychains', 'qa-signing.keychain-db');
    if (!fs.existsSync(kc)) return { code: 1, result: { ok: false, error: `--identity needs the QA signing keychain ${kc} (scripts/qa/signing-keychain.sh)` } };
    sys.run('/usr/bin/security', ['unlock-keychain', '-p', '', kc]);
  }
  const args = [CLI, 'setup', '--root', root, '--identity', identity, '--app-path', P.appPath, ...QA_BUILD_POLICY, '--json'];
  if (diag || probe) args.push('--source', makeDiagSource(root, { diag, probe }));
  if (stock) args.push('--stock', stock);
  const r = sys.run(process.execPath, args, { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, CODEX_MODS_ROOT: root } });
  let summary = null;
  try { summary = JSON.parse(r.stdout); } catch { /* human output or failure */ }
  // Every launch of the QA copy, also the ones the framework makes (the swap helper's reopen after an update, the loader's revert), never
  // touches the real Keychain: the switch rides in the profile's launchArgs (builder/KEYCHAIN.md §4). And the QA identity's keychain, for
  // builds the Host makes in the app's session (an update's staging, E5), which unlocks it (empty password).
  if (r.status === 0) {
    try {
      const pj = readJson(P.layout.profileConfig);
      const kc = path.join(os.homedir(), 'Library', 'Keychains', 'qa-signing.keychain-db');
      const want = { ...pj, launchArgs: [`--user-data-dir=${P.layout.userData}`, MOCK_KEYCHAIN_SWITCH], ...(identity !== '-' ? { signingKeychain: kc } : {}) };
      if (pj && JSON.stringify(want) !== JSON.stringify(pj)) fs.writeFileSync(P.layout.profileConfig, `${JSON.stringify(want, null, 2)}\n`);
    } catch { /* setup's own result reports the profile */ }
  }
  const profile = readJson(P.layout.profileConfig);
  const result = { ok: r.status === 0, exit: r.status, seconds: Math.round((Date.now() - t0) / 100) / 10, root, appPath: P.appPath, profile, summary,
    ...(r.status === 0 ? {} : { stderr: String(r.stderr).trim().slice(-2000), stdout: String(r.stdout).trim().slice(-1000) }) };
  if (r.status === 0 && profile) {
    const bad = [];
    if (profile.signingIdentity !== identity) bad.push(`signingIdentity is ${profile.signingIdentity}, expected ${identity}`);
    if (profile.codexHome !== P.layout.codexHome) bad.push(`codexHome is ${profile.codexHome}, expected the isolated ${P.layout.codexHome}`);
    if (JSON.stringify(profile.launchArgs) !== JSON.stringify([`--user-data-dir=${P.layout.userData}`, MOCK_KEYCHAIN_SWITCH])) bad.push(`launchArgs is ${JSON.stringify(profile.launchArgs)}`);
    if (profile.guardStockApp) bad.push('guardStockApp is set on a QA profile');
    if (bad.length) { result.ok = false; result.problems = bad; }
  }
  if (result.ok && profile) {
    try { result.computerUseHelper = cleanStaleComputerUseHelper({ root, codexHome: profile.codexHome }); } catch (e) { result.ok = false; result.computerUseHelper = { error: String(e.message ?? e) }; }
    try { result.configToml = ensureQaComputerUseOff({ codexHome: profile.codexHome, isolatedCodexHome: P.layout.codexHome }); } catch (e) { result.ok = false; result.configToml = { error: String(e.message ?? e) }; }
  }
  // Older or reused candidates may predate the QA build policy. Do not patch a signed bundle in place.
  const report = fs.existsSync(P.appPath) ? readJson(path.join(path.dirname(fs.realpathSync(P.appPath)), 'build-report.json')) : null;
  if (result.ok && (rebuild || report?.infoPlist?.qaNoRestore !== true || report?.qaSocketDirs?.applied !== true)) {
    try { result.rebuild = await forceRebuild({ root, profile }); } catch (e) { result.ok = false; result.rebuild = { error: String(e.message ?? e) }; }
  }
  // A QA profile's setup builds a new copy whenever the framework changed but does not select it (the launch symlink stays put), and
  // a rebuild supersedes the copy it replaces: about 1.8 GB each, so every successful setup removes the superseded copies of the build.
  const build = summary?.steps?.find((s) => s.step === 'copy')?.build;
  if (result.ok && build) {
    try { result.pruned = await pruneSupersededCopies(root, build); } catch (e) { result.pruned = { error: String(e.message ?? e) }; }
  }
  if (result.ok) { try { result.prunedFrameworks = pruneSupersededFrameworks(root).length; } catch (e) { result.prunedFrameworks = { error: String(e.message ?? e) }; } }
  if (result.ok) { result.restoration = restorePolicy(root); result.ok = result.restoration.ok; }
  return { code: result.ok ? 0 : 1, result };
}

/** This root's protected apps/ directories (protectedAppDirs), as the launch symlink, lkg-app, qa/previous-app and boot records say now. */
async function appProtection(root) {
  const P = qaPaths(root);
  const sup = await import('../../framework/host/recovery/support.mjs');
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  const text = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
  let generationApps = [];
  try {
    generationApps = fs.readdirSync(P.layout.generations).filter((n) => /^\d+\.json$/.test(n))
      .map((n) => readJson(path.join(P.layout.generations, n))?.appCandidate).filter((a) => typeof a === 'string' && a);
  } catch { /* no boot records yet */ }
  return protectedAppDirs({ symlinkTarget: sup.readLinkAbs(P.appPath), lkgAppText: text(P.layout.lkgApp), previousAppText: text(P.previousApp), generationApps, realpath: real });
}

const UNFINISHED_MS = 60 * 60_000;   // a copy without build-report.json younger than this may still be building (another setup)
const OTHER_BUILD_MS = 2 * 24 * 60 * 60_000;   // another build's copy no record names, untouched this long, goes too (the disk is small)
/** Remove the superseded copies of `build` (supersededCopies) and return their names. */
export async function pruneSupersededCopies(root, build) {
  const P = qaPaths(root);
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  const protectedDirs = await appProtection(root);
  const commands = owned(root).list.map((p) => p.command);
  const names = (() => { try { return fs.readdirSync(P.layout.apps); } catch { return []; } })();
  const pruned = supersededCopies({
    build, names,
    isProtected: (n) => protectedDirs.has(real(path.join(P.layout.apps, n))),
    inUse: (n) => rootsOf(root).some((r) => commands.some((c) => c.includes(`${path.join(r, 'apps', n)}/`))),
    unfinished: (n) => {
      const dir = path.join(P.layout.apps, n);
      if (fs.existsSync(path.join(dir, 'build-report.json'))) return false;
      try { return Date.now() - fs.statSync(dir).mtimeMs < UNFINISHED_MS; } catch { return false; }
    },
    stale: (n) => { try { return Date.now() - fs.statSync(path.join(P.layout.apps, n)).mtimeMs > OTHER_BUILD_MS; } catch { return false; } },
  });
  for (const n of pruned) fs.rmSync(path.join(P.layout.apps, n), { recursive: true, force: true });
  return pruned;
}

/** Remove the superseded framework versions (supersededFrameworks): kept are the pointers' versions and those any profile's boot records name. */
export function pruneSupersededFrameworks(root) {
  const P = qaPaths(root);
  const dir = P.layout.framework;
  const names = (() => { try { return fs.readdirSync(dir); } catch { return []; } })();
  const kept = new Set();
  for (const p of ['current', 'previous', 'lkg']) { try { kept.add(fs.readFileSync(path.join(dir, p), 'utf8').trim()); } catch { /* none */ } }   // each holds a version
  for (const profile of (() => { try { return fs.readdirSync(path.join(root, 'profiles')); } catch { return []; } })()) {
    const gens = path.join(root, 'profiles', profile, 'generations');
    for (const n of (() => { try { return fs.readdirSync(gens); } catch { return []; } })()) {
      const v = n.endsWith('.json') ? readJson(path.join(gens, n))?.frameworkVersion : null;
      if (typeof v === 'string' && v) kept.add(v);
    }
  }
  const mtime = (n) => { try { return fs.statSync(path.join(dir, n)).mtimeMs; } catch { return 0; } };
  const pruned = supersededFrameworks({ names, kept, mtime });
  for (const n of pruned) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
  return pruned;
}

/**
 * QA profiles run with `[features] computer_use = false` in their CODEX_HOME config, which turns off the Computer Use feature. It does not
 * keep the helper from starting: the app also starts it for appshots and Chronicle, which are server-gated (ARCHITECTURE §5.3). The
 * isolation check therefore accepts the copy's own relocated helper with its private CODEX_HOME (isolation.mjs `relocatedHelperHome`).
 * Only the profile's own isolated CODEX_HOME is ever written (never ~/.codex); other keys are preserved, the file is rewritten only when it
 * changes, and the original is saved once as config.toml.qa-backup.
 */
export function ensureQaComputerUseOff({ codexHome, isolatedCodexHome }) {
  if (!codexHome || path.resolve(codexHome) !== path.resolve(isolatedCodexHome)) return { skipped: `codexHome ${codexHome} is not the QA profile's isolated one` };
  const file = path.join(codexHome, 'config.toml');
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const existed = fs.existsSync(file);
  const before = existed ? fs.readFileSync(file, 'utf8') : '';
  const { text, changed } = ensureTomlBool(before, 'features', 'computer_use', false);
  if (!changed) return { path: file, changed: false };
  const backup = existed ? backupOnce(file) : null;
  writeFileAtomic(file, text);
  return { path: file, changed: true, backup };
}

/** Save `<file>.qa-backup` the first time only; returns its path when it was created now, else null. */
function backupOnce(file) {
  const bak = `${file}.qa-backup`;
  if (!fs.existsSync(file) || fs.existsSync(bak)) return null;
  fs.copyFileSync(file, bak); fs.chmodSync(bak, 0o600);
  return bak;
}
function writeFileAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const realOr = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
/** realpath of the longest existing ancestor, with the missing tail re-appended. */
function realOfMissing(p) {
  let cur = path.resolve(p); const tail = [];
  while (!fs.existsSync(cur) && path.dirname(cur) !== cur) { tail.unshift(path.basename(cur)); cur = path.dirname(cur); }
  return path.join(realOr(cur), ...tail);
}
const strictlyInside = (child, parent) => child !== parent && child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

function collectHelperFiles(dir) {
  const files = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { walk(full, path.join(rel, e.name)); continue; }
      if (!e.isFile()) continue;
      const fd = fs.openSync(full, 'r');
      const head = Buffer.alloc(4);
      try { fs.readSync(fd, head, 0, 4, 0); } finally { fs.closeSync(fd); }
      if (isRelevantFile(e.name, head)) files.push({ rel: path.join(rel, e.name), bytes: fs.readFileSync(full) });
    }
  })(dir, '');
  return files;
}

/**
 * QA setup: remove a Computer Use helper copy in <codexHome>/computer-use/ whose Info.plist/binaries do not carry the copy's renamed
 * container id, and the SKY_CUA_SERVICE_PATH line that points at it (config.toml backed up once as config.toml.qa-backup). Only a
 * codexHome strictly inside the QA root is ever touched; a symlinked computer-use entry is unlinked, never followed.
 */
export function cleanStaleComputerUseHelper({ root, codexHome }) {
  const rootReal = realOr(root);
  if (!codexHome || !fs.existsSync(codexHome)) return { skipped: 'no CODEX_HOME yet' };
  const homeReal = realOr(codexHome);
  if (!strictlyInside(homeReal, rootReal)) return { skipped: `codexHome ${codexHome} is not inside the QA root` };
  const dir = path.join(homeReal, 'computer-use');
  const result = { state: 'absent', removedDir: false, removedConfigLines: [], backup: null };
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  let stale = false;
  if (st?.isSymbolicLink()) { stale = true; result.state = 'symlink'; fs.unlinkSync(dir); result.removedDir = true; }
  else if (st?.isDirectory()) {
    const cls = classifyHelper(collectHelperFiles(dir));
    result.state = cls.state; result.evidence = { renamedIn: cls.renamedIn.slice(0, 3), stockIn: cls.stockIn.slice(0, 3) };
    if (cls.state !== 'renamed') {
      if (!strictlyInside(realOr(dir), homeReal)) return { ...result, skipped: 'computer-use resolves outside CODEX_HOME' };
      fs.rmSync(dir, { recursive: true, force: true }); stale = true; result.removedDir = true;
    }
  }
  const cfg = path.join(homeReal, 'config.toml');
  if (fs.existsSync(cfg)) {
    const text = fs.readFileSync(cfg, 'utf8');
    const value = tomlStringValue(text, 'SKY_CUA_SERVICE_PATH');
    const dangling = value !== null && strictlyInside(realOfMissing(value), dir) && !fs.existsSync(value); // points into a helper that is gone
    if (value !== null && (stale || dangling)) {
      const r = removeTomlKeyLines(text, 'SKY_CUA_SERVICE_PATH');
      if (r.removed.length) { result.backup = backupOnce(cfg); writeFileAtomic(cfg, r.text); result.removedConfigLines = r.removed; }
    }
  }
  return result;
}

/**
 * Force a fresh copy of the installed stock build. The matching apps/<build>-<hash> is deleted and rebuilt only when it is not
 * protected (appProtection); otherwise the new copy goes to <name>-r<N> (N = first unused). Either way the launch symlink is then
 * repointed atomically and the target it replaced is recorded in qa/previous-app, so the prune that ends setup keeps it. Never runs
 * while an owned process is up.
 */
export async function forceRebuild({ root, profile }) {
  const P = qaPaths(root);
  const sup = await import('../../framework/host/recovery/support.mjs');
  const running = owned(root).list;
  if (running.length) throw new Error(`owned processes are running (stop first): ${running.map((p) => `${p.pid} ${roleOf(p.command)}: ${p.command.slice(0, 100)}`).join('; ')}`);
  const stockApp = profile?.stockApp ?? '/Applications/ChatGPT.app';   // the profile's stock (E5: QA may use a clone)
  const stock = sup.readAppBuildSync(stockApp);
  const version = fs.readFileSync(P.layout.frameworkCurrent, 'utf8').trim();
  const frameworkDir = path.join(P.layout.framework, version);
  const adapterPath = path.join(P.layout.adapters, stock.build, 'adapter.json');
  const hash = await sup.resolveInputsHash({ adapterPath, frameworkDir, identity: profile?.signingIdentity || '-', frameworkVersion: version });
  const base = sup.candidateDirName(stock.build, hash);
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  const protectedDirs = await appProtection(root);
  const matching = path.join(P.layout.apps, base);
  const out = { base, previousTarget: sup.readLinkAbs(P.appPath) ?? null };
  const plan = planRebuildDir({ base, exists: (n) => fs.existsSync(path.join(P.layout.apps, n)), isProtected: (n) => protectedDirs.has(real(path.join(P.layout.apps, n))) });
  const outDir = path.join(P.layout.apps, plan.name);
  if (plan.reason) out.reason = plan.reason;
  if (plan.deleteExisting) { fs.rmSync(matching, { recursive: true, force: true }); out.deleted = matching; }
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const t0 = Date.now();
  try { await sup.runBuilderProcess(sup.builderArgs({ layout: P.layout, profile, stockApp, adapterPath, frameworkDir, frameworkVersion: version, outDir, extraArgs: QA_BUILD_POLICY })); } catch (e) { fs.rmSync(outDir, { recursive: true, force: true }); throw e; }
  const app = sup.findAppSync(outDir);
  if (!app || !fs.existsSync(path.join(outDir, 'build-report.json'))) { fs.rmSync(outDir, { recursive: true, force: true }); throw new Error(`the builder produced no complete copy in ${outDir}`); }
  await sup.replaceSymlinkAtomic(P.appPath, app);
  if (out.previousTarget) await sup.writeTextAtomic(P.previousApp, `${out.previousTarget}\n`);
  return { ...out, newDir: outDir, candidate: app, reused: false, seconds: Math.round((Date.now() - t0) / 100) / 10, target: sup.readLinkAbs(P.appPath) };
}

// ----------------------------------------------------------------------------------------------- management
async function managementCalls(root, methods) {
  const P = qaPaths(root);
  const client = await connectHost({ socketPath: path.join(P.layout.run, SOCKETS.management), tokenPath: path.join(P.layout.run, 'mgmt.token') });
  try {
    const out = {};
    for (const m of methods) out[m] = await client.call(m, {}).catch((e) => ({ error: { code: e.code, message: e.message } }));
    return out;
  } finally { client.close(); }
}

export async function status({ root }) {
  try {
    const P = qaPaths(root);
    // prompt safety net on every status call while the app runs
    const running = owned(root);
    const untracked = unmanaged(root, running.list);
    const outside = { ok: false, running: true, error: 'outside-harness', unmanaged: untracked.map((p) => ({ pid: p.pid, command: p.command })), instruction: restorationInstruction(root) };
    let keychainCheck = { skipped: 'the app is not running' };
    if (running.list.length) {
      const main = findMain(running.list);
      const launchedAt = Date.parse(readJson(P.lastLaunch)?.launchedAt ?? '') || Date.now() - 10 * 60_000;
      const scan = scanKeychainPrompts({ root, sinceMs: launchedAt, pids: (main ? family(running.rows, main.pid) : running.list).map((p) => p.pid) });
      if (!scan.ok || scan.prompts.length) {
        const r = await handleKeychainPrompt({ root, scan, stage: 'status' });
        if (untracked.length) Object.assign(r.result, { unmanaged: outside.unmanaged, instruction: outside.instruction });
        return r;
      }
      keychainCheck = { ok: true, prompts: 0 };
    }
    if (untracked.length) return { code: 3, result: { ...outside, keychainCheck } };
    const r = await managementCalls(root, ['diagnostics', 'mods.list', 'compat.report', 'updates.status']);
    return { code: 0, result: { running: true, keychainCheck, diagnostics: r.diagnostics, mods: r['mods.list'], compat: r['compat.report'], updates: r['updates.status'] } };
  } catch (e) {
    if (e instanceof HostNotRunning) return { code: 2, result: { running: false, reason: e.message } };
    throw e;
  }
}

// ----------------------------------------------------------------------------------------------- keychain prompt safety net
/**
 * Look for securityd's "displaying keychain prompt" lines since `sinceMs` that belong to this run. A check that cannot run is reported
 * (ok:false), never treated as "no prompt".
 */
export function scanKeychainPrompts({ root, sinceMs, pids = [] }) {
  const args = logShowArgs(sinceMs - 3000);
  const r = sys.logShow(args);
  if (r.error || r.status !== 0) return { ok: false, error: r.error ? String(r.error.message) : `log show exit ${r.status}: ${String(r.stderr || '').trim().slice(0, 200)}`, prompts: [] };
  const all = parsePromptLog(r.stdout);
  return { ok: true, scanned: all.length, prompts: matchPrompts(all, { pids: new Set(pids), roots: rootsOf(root), sinceMs: sinceMs - 3000 }) };
}

/** A prompt appeared (or the check broke): stop the app, kill the dialog, write evidence, and report the failure. */
export async function handleKeychainPrompt({ root, scan, stage }) {
  const P = qaPaths(root);
  const result = { ok: false, error: scan.ok === false ? 'keychain-prompt-check-failed' : ERROR_PROMPT, stage, detectedAt: new Date().toISOString(),
    prompts: scan.prompts.map((p) => ({ ts: p.ts, pid: p.pid, path: p.path, item: p.item })), checkError: scan.ok === false ? scan.error : undefined };
  result.stopped = (await stop({ root })).result;
  result.securityAgent = await dismissSecurityAgents({ ps: () => sys.ps(), kill: (pid, sig) => sys.kill(pid, sig), sleep });
  writeJson(path.join(P.qaDir, 'keychain-prompt.json'), result);
  return { code: EXIT_PROMPT, result };
}

// ----------------------------------------------------------------------------------------------- isolation
export function collectIsolation(root, rows, mainPid, { requireCodexHomeObserved, requireUserDataObserved = requireCodexHomeObserved, codexHome, userData, cuRefresh = false, noenv = false }) {
  const P = qaPaths(root);
  const procs = family(rows, mainPid);
  const home = os.homedir();
  const { files, processes, failures } = inspectGroup(procs, mainPid);
  const evaluation = evaluateIsolation({
    processes: processes.map((p) => ({ pid: p.pid, role: roleOf(p.command), envLine: p.envLine, command: p.command })),
    files, inspectFailures: failures,
    expected: {
      codexHomes: [...new Set(rootsOf(root).map((r) => codexHome ? path.join(r, codexHome) : path.join(r, 'profiles', P.layout.profile, 'codex-home')))],
      userDataDirs: [...new Set(rootsOf(root).map((r) => userData ? path.join(r, userData) : path.join(r, 'profiles', P.layout.profile, 'userData')))],
      home,
      computerUseDirs: [...new Set(rootsOf(root).map((r) => path.join(r, 'profiles', P.layout.profile, 'computer-use')))],
      bundleDirs: [...new Set(rootsOf(root).map((r) => path.join(r, 'apps')))],
      backendDirs: [...new Set(rootsOf(root).map((r) => path.join(r, 'profiles', P.layout.profile, 'backends')))],
    },
    requireCodexHomeObserved, requireUserDataObserved,
    requireSparkleEnv: !noenv, requireSkipCuEnv: !noenv && !cuRefresh,
  });
  const untracked = unmanaged(root, ownedProcesses(rows, rootsOf(root), selfAndAncestors(rows, process.pid)));
  for (const p of untracked) evaluation.violations.push({ kind: 'outside-harness', pid: p.pid, detail: restorationInstruction(root) });
  evaluation.ok = evaluation.violations.length === 0;
  return { ...evaluation, pids: procs.map((p) => p.pid), tree: procs.map((p) => `${p.pid} ppid=${p.ppid} pgid=${p.pgid} ${roleOf(p.command)}`) };
}

/** ps eww per process and one lsof over the group. Any failure or empty output is reported, never swallowed. */
export function inspectGroup(procs, mainPid) {
  const failures = [];
  const processes = [];
  for (const p of procs) {
    const r = sys.psEnv(p.pid);
    const ok = !r.error && r.status === 0 && String(r.stdout).includes(String(p.pid));
    if (ok) { processes.push({ ...p, envLine: String(r.stdout) }); continue; }
    if (!sys.ps().some((x) => x.pid === p.pid)) continue; // exited between listing and inspection: nothing to inspect
    failures.push({ pid: p.pid, command: 'ps eww', detail: r.error ? String(r.error.message) : `exit ${r.status}${String(r.stderr || '').trim() ? `: ${String(r.stderr).trim().slice(0, 120)}` : ''}${r.status === 0 ? ' with no output for the pid' : ''}` });
  }
  const l = sys.lsof(procs.map((p) => p.pid));
  const out = String(l.stdout ?? '');
  // lsof exits 1 when some listed pid vanished but still reports the others; status > 1, a spawn error, or no output at all is a failure
  if (l.error || (l.status ?? 2) > 1 || out.trim() === '') failures.push({ command: 'lsof', detail: l.error ? String(l.error.message) : `exit ${l.status}${out.trim() === '' ? ', empty output' : ''}${String(l.stderr || '').trim() ? `: ${String(l.stderr).trim().slice(0, 120)}` : ''}` });
  const files = parseLsofF(out);
  if (!failures.some((f) => f.command === 'lsof') && !out.split('\n').includes(`p${mainPid}`) && sys.ps().some((x) => x.pid === mainPid)) failures.push({ command: 'lsof', pid: mainPid, detail: 'the main process is missing from the lsof report' });
  return { files, processes, failures };
}

// ----------------------------------------------------------------------------------------------- stop
const goneAll = (root) => owned(root).list.length === 0;
async function waitGone(root, ms) { const t = Date.now(); while (Date.now() - t < ms) { if (goneAll(root)) return true; await sleep(300); } return goneAll(root); }

/**
 * The stock app serves its webview with fs.createReadStream on paths inside app.asar, and Electron opens such a path by extracting the
 * file to <user temp dir>/.<bundle id>.XXXXXX, which it never deletes: every launch leaves about 950 of them (around 50 MB, 72k files
 * on the QA user in four days). A running copy reuses its extracted paths, so they are removed only when no modded copy of this user
 * runs (any root). Never fails the caller.
 * @param {{dir?: string, rows?: Array<{command: string}>, bundleId?: string}} [o] test seams
 */
export function clearCopyTempFiles({ dir, rows, bundleId = COPY_BUNDLE_ID } = {}) {
  try {
    if (modCopyRunning(rows ?? sys.ps())) return { skipped: 'a modded copy is running' };
    dir = dir ?? String(sys.run('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR']).stdout ?? '').trim();
    if (!dir) return { skipped: 'no user temp dir' };
    let removed = 0, bytes = 0;
    for (const n of copyTempFiles(fs.readdirSync(dir), bundleId)) {
      const p = path.join(dir, n);
      try { const st = fs.lstatSync(p); if (!st.isFile()) continue; fs.rmSync(p); removed += 1; bytes += st.size; } catch { /* already gone */ }
    }
    return { removed, bytes };
  } catch (e) { return { error: String(e.message ?? e) }; }
}

export async function stop({ root }) {
  const P = qaPaths(root);
  const t0 = Date.now();
  const before = owned(root);
  const result = { root, startedWith: before.list.map((p) => `${p.pid} ${roleOf(p.command)}`), stages: [] };
  if (!before.list.length) {
    result.restoration = restorePolicy(root); result.ok = result.restoration.ok; result.note = 'nothing owned was running'; result.tempFiles = clearCopyTempFiles(); fs.rmSync(launchFile(root), { force: true }); writeJson(P.lastStop, result); fs.rmSync(fixtureFile(root), { force: true });
    return { code: result.ok ? 0 : 1, result };
  }
  const exclude = selfAndAncestors(before.rows, process.pid);
  const main = findMain(before.list);
  const stage = async (name, act, waitMs) => { const info = act(); result.stages.push({ stage: name, ...info, gone: await waitGone(root, waitMs) }); return goneAll(root); };
  const signalAll = (sig, { mainOnly = false } = {}) => () => {
    const cur = owned(root);
    if (mainOnly) { const m = findMain(cur.list); return { signal: sig, pids: m ? [m.pid] : [], sent: m ? sys.kill(m.pid, sig) : false }; }
    const t = signalTargets(cur.rows, cur.list, exclude);
    for (const g of t.groups) sys.kill(-g, sig);
    for (const pid of t.pids) sys.kill(pid, sig);
    return { signal: sig, groups: t.groups, pids: t.pids };
  };
  let done = false;
  if (main) {
    // 1. graceful: AppleScript quit. The app may refuse (observed: "User canceled (-128)"), in which case waiting is pointless.
    const script = `tell application "${fs.existsSync(P.appPath) ? fs.realpathSync(P.appPath) : P.appPath}" to quit`;
    const q = sys.run('/usr/bin/osascript', ['-e', script], { timeout: 10000 });
    const refused = q.status !== 0;
    result.stages.push({ stage: 'applescript-quit', status: q.status, refused, stderr: String(q.stderr || '').trim().slice(0, 300) });
    done = refused ? false : await waitGone(root, 15000);
    if (!refused) result.stages.push({ stage: 'wait-15s', gone: done });
    // 2. SIGTERM to the main pid only: framework-main's shutdown gets its 10 s budget to stop the Host and the backends.
    if (!done) done = await stage('sigterm-main', signalAll('SIGTERM', { mainOnly: true }), 10000);
  }
  // 3. the rest of the process group, then 4. SIGKILL
  if (!done) done = await stage('sigterm-group', signalAll('SIGTERM'), 5000);
  if (!done) await stage('sigkill', signalAll('SIGKILL'), 3000);
  const left = owned(root).list;
  if (!left.length) { fs.rmSync(launchFile(root), { force: true }); result.tempFiles = clearCopyTempFiles(); }
  result.restoration = restorePolicy(root);
  result.ok = left.length === 0 && result.restoration.ok;
  result.remaining = left.map((p) => `${p.pid} ${roleOf(p.command)} ${p.command.slice(0, 160)}`);
  result.seconds = Math.round((Date.now() - t0) / 100) / 10;
  writeJson(P.lastStop, result);
  fs.rmSync(fixtureFile(root), { force: true }); // the fixture is the tester's; it was never signalled and is no longer excluded
  return { code: result.ok ? 0 : 1, result };
}

// ----------------------------------------------------------------------------------------------- launch
/**
 * `--guard` turns the profile's stock/CLI concurrency guard on for this launch only: profile.json is rewritten with guardStockApp:true
 * before the app starts and restored byte for byte afterwards (also when the launch fails).
 */
export async function launch(opts) {
  if (!opts.guard) return launchInner(opts);
  const P = qaPaths(opts.root);
  if (!fs.existsSync(P.layout.profileConfig)) return { code: 1, result: { ok: false, error: `no QA profile at ${P.layout.profileConfig}: run "setup" first` } };
  const { value: r, guard } = await withProfileGuard(P.layout.profileConfig, () => launchInner(opts));
  r.result.guard = guard;
  if (!guard.restored) { r.result.ok = false; r.code = r.code || 1; }
  return r;
}

/** Run `fn` with profile.json's guardStockApp forced on; restore the original bytes afterwards, also when fn throws. */
export async function withProfileGuard(file, fn) {
  const original = fs.readFileSync(file);
  const profile = JSON.parse(original.toString('utf8'));
  writeFileAtomic(file, `${JSON.stringify({ ...profile, guardStockApp: true }, null, 2)}\n`);
  let value;
  try { value = await fn(); } finally {
    const tmp = `${file}.restore-${process.pid}`;
    fs.writeFileSync(tmp, original, { mode: 0o600 }); fs.renameSync(tmp, file);
  }
  return { value, guard: { enabledForThisLaunch: true, originalGuardStockApp: profile.guardStockApp ?? false, restored: fs.readFileSync(file).equals(original) } };
}

/** Updater evidence for --noenv: updater processes in the app group and updater/appcast lines in this run's logs. */
export function collectUpdaterEvidence(root, rows, mainPid) {
  const P = qaPaths(root);
  const procs = family(rows, mainPid);
  const logs = [];
  const read = (file) => { try { return fs.readFileSync(file, 'utf8').split('\n').slice(-4000); } catch { return null; } };
  const d = new Date();
  for (const back of [0, 1]) {
    const day = new Date(d.getTime() - back * 86400000);
    const dir = path.join(os.homedir(), 'Library', 'Logs', 'com.openai.codex', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
    let names = []; try { names = fs.readdirSync(dir); } catch { /* none */ }
    for (const n of names) if (n.includes(`-${mainPid}-`)) { const lines = read(path.join(dir, n)); if (lines) logs.push({ file: n, lines }); }
  }
  let own = []; try { own = fs.readdirSync(P.layout.logs).filter((n) => n.endsWith('.log')); } catch { /* none */ }
  for (const n of own) { const lines = read(path.join(P.layout.logs, n)); if (lines) logs.push({ file: `profile/${n}`, lines }); }
  return updaterViolations({ processes: procs, logs });
}

async function launchInner({ root, keep = false, fast = false, cuRefresh = false, noenv = false, guard = false, readyTimeoutMs = 60000, lateOffsets }) {
  const P = qaPaths(root);
  const profile = readJson(P.layout.profileConfig);
  if (!profile || !fs.existsSync(P.appPath)) return { code: 1, result: { ok: false, error: `no QA profile / app at ${P.appPath}: run "setup" first` } };
  fs.rmSync(fixtureFile(root), { force: true }); // a previous run's fixture list never applies to a new launch
  const before = owned(root);
  let blocking = before.list; let guardFixture = null;
  if (guard) {
    const codexHomes = [...new Set(rootsOf(root).map((r) => path.resolve(r, 'profiles', P.layout.profile, 'codex-home')))];
    const c = classifyGuardFixtures(before.list, { codexHomes, appsDirs: rootsOf(root).map((r) => path.join(r, 'apps')), envLineOf: (pid) => sys.psEnv(pid)?.stdout });
    blocking = c.others;
    if (c.fixtures.length) {
      guardFixture = { pids: c.fixtures.map((f) => f.pid), processes: c.fixtures.map((f) => ({ pid: f.pid, command: f.command.slice(0, 200) })), codexHomes, excludedFromOwnershipAndIsolation: true };
      writeJson(fixtureFile(root), { at: new Date().toISOString(), fixtures: c.fixtures.map((f) => ({ pid: f.pid, command: f.command })) });
    }
  }
  if (blocking.length) return { code: 1, result: { ok: false, error: 'an owned app process is already running; run "stop" first', running: blocking.map((p) => `${p.pid} ${roleOf(p.command)}`) } };
  const restoration = restorePolicy(root);
  if (!restoration.ok) return { code: 1, result: { ok: false, restoration } };
  const launchId = randomUUID();
  writeJson(launchFile(root), { launchId });
  const launchedAt = Date.now();
  const result = { ok: false, root, appPath: P.appPath, restoration, ...(guardFixture ? { guardFixture } : {}), launchArgs: profile.launchArgs, launchedAt: new Date(launchedAt).toISOString(), timings: {} };
  const mode = { cuRefresh, noenv };
  result.launchMode = mode;
  const openArgs = buildOpenArgs(P.appPath, profile.launchArgs, { ...mode, launchId });
  const o = sys.run('/usr/bin/open', openArgs);
  result.open = { args: openArgs, status: o.status, stderr: String(o.stderr).trim().slice(0, 500) };
  if (o.status !== 0) { writeJson(P.lastLaunch, result); return { code: 1, result }; }
  const fail = async (code, why, extra = {}) => {
    Object.assign(result, { ok: false, failure: why, ...extra });
    result.hostLogTail = tail(path.join(P.layout.logs, 'host.log'), 40);
    if (!keep || code === 3) result.stopped = (await stop({ root })).result;
    writeJson(P.lastLaunch, result);
    return { code, result };
  };

  let main;
  while (!main && Date.now() - launchedAt < 30000) { main = findMain(owned(root).list); if (!main) await sleep(300); }
  if (!main) return fail(1, 'the app process did not appear within 30 s');
  result.timings.mainAppearedMs = Date.now() - launchedAt;
  result.pids = { main: main.pid };
  writeJson(launchFile(root), { launchId, pid: main.pid });

  // early isolation check (launch env only; the backend does not exist yet)
  const early = collectIsolation(root, sys.ps(), main.pid, { requireCodexHomeObserved: false, requireUserDataObserved: false, ...mode });
  result.isolationEarly = early;
  if (!early.ok) return fail(3, 'isolation violation (early)', { violations: early.violations });

  // keychain prompt safety net: any "displaying keychain prompt" for this run's pids/paths stops everything
  const kc = { checks: 0, lastAt: 0 };
  const promptCheck = async (stage) => {
    kc.checks += 1; kc.lastAt = Date.now();
    const scan = scanKeychainPrompts({ root, sinceMs: launchedAt, pids: family(sys.ps(), main.pid).map((p) => p.pid) });
    if (scan.ok && scan.prompts.length === 0) return null;
    const h = await handleKeychainPrompt({ root, scan, stage });
    Object.assign(result, { ok: false, failure: h.result.error, keychainPrompt: h.result });
    writeJson(P.lastLaunch, result);
    return h;
  };

  let readiness; let diagnostics = null;
  while (Date.now() - launchedAt < readyTimeoutMs) {
    if (Date.now() - kc.lastAt > 3000) { const h = await promptCheck('launch-wait'); if (h) return h; }
    const rows = sys.ps();
    const hostPids = new Set(family(rows, main.pid).map((p) => p.pid));
    diagnostics = null;
    try { const r = await managementCalls(root, ['diagnostics']); diagnostics = r.diagnostics?.error ? null : r.diagnostics; } catch { /* not up yet */ }
    readiness = evaluateReadiness({ diagnostics, boot: readJson(P.bootMarker), hostPids, launchedAtMs: launchedAt });
    const t = Date.now() - launchedAt;
    for (const [k, v] of Object.entries(readiness.checks)) if (v && result.timings[k] === undefined) result.timings[k] = t;
    if (readiness.ready) { result.timings.readyMs = t; break; }
    if (!family(rows, main.pid).some((p) => p.pid === main.pid)) return fail(1, 'the app exited while waiting for readiness', { readiness });
    await sleep(500);
  }
  result.readiness = readiness;
  if (readiness?.ready) { await sleep(3000); } // sign-in cookie writes happen shortly after readiness
  { const h = await promptCheck('launch-final'); if (h) return h; }
  result.keychain = { checks: kc.checks, prompts: 0, mockKeychain: true };
  const rows = sys.ps();
  const final = collectIsolation(root, rows, main.pid, { requireCodexHomeObserved: readiness?.ready === true, ...mode });
  result.isolation = final;
  result.pids.group = final.pids;
  result.pids.host = diagnostics?.host?.pid ?? null;
  if (!final.ok) return fail(3, 'isolation violation', { violations: final.violations });
  if (noenv) {
    const u = collectUpdaterEvidence(root, rows, main.pid);
    result.updaterEvidence = { checks: 1, violations: u };
    if (u.length) return fail(3, 'updater activity without CODEX_SPARKLE_ENABLED', { violations: u });
  }
  if (!readiness?.ready) return fail(1, `not ready within ${readyTimeoutMs / 1000} s (missing: ${readiness?.missing?.join(', ')})`);
  // services that start after sign-in (the Computer Use helper) are covered by re-running the strict checks later
  if (!fast) {
    result.isolationLate = [];
    const readyAt = launchedAt + (result.timings.readyMs ?? 0);
    for (const step of planLateChecks(readyAt, Date.now(), lateOffsets)) {
      if (step.waitMs) await sleep(step.waitMs);
      const h = await promptCheck(`late+${step.offsetMs / 1000}s`); if (h) return h;
      const r2 = sys.ps();
      if (!family(r2, main.pid).some((p) => p.pid === main.pid)) return fail(1, `the app exited before the +${step.offsetMs / 1000} s isolation re-check`);
      const late = collectIsolation(root, r2, main.pid, { requireCodexHomeObserved: true, ...mode });
      result.isolationLate.push({ offsetMs: step.offsetMs, ok: late.ok, violations: late.violations, info: late.info, pids: late.pids.length, userDataFilesByMainOrRenderer: late.userDataFilesByMainOrRenderer });
      if (!late.ok) return fail(3, `isolation violation at +${step.offsetMs / 1000} s after readiness`, { violations: late.violations });
      if (noenv) {
        const u = collectUpdaterEvidence(root, r2, main.pid);
        result.updaterEvidence.checks += 1;
        if (u.length) { result.updaterEvidence.violations = u; return fail(3, `updater activity at +${step.offsetMs / 1000} s without CODEX_SPARKLE_ENABLED`, { violations: u }); }
      }
    }
  }
  if (final.info && Object.keys(final.info).length) result.isolationInfo = final.info;
  result.mux = diagnostics.mux;
  result.hostInfo = diagnostics.host;
  result.boot = readJson(P.bootMarker);
  try { const c = await managementCalls(root, ['compat.report']); result.compat = c['compat.report']; } catch (e) { result.compat = { error: String(e.message) }; }
  result.ok = true;
  writeJson(P.lastLaunch, result);
  return { code: 0, result };
}

function tail(file, n) { try { return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-n); } catch { return null; } }

// ----------------------------------------------------------------------------------------------- screenshot
export function screenshot({ root, name }) {
  const P = qaPaths(root);
  fs.mkdirSync(P.shots, { recursive: true, mode: 0o700 });
  const file = path.join(P.shots, `${name}.png`);
  const session = sys.run('/bin/launchctl', ['managername'], { timeout: 5000 }).stdout?.trim() ?? 'unknown';
  const r = sys.run('/usr/sbin/screencapture', ['-x', file], { timeout: 15000 });
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  if (r.status === 0 && size > 0) return { code: 0, result: { ok: true, available: true, file, bytes: size, session } };
  fs.rmSync(file, { force: true });
  return { code: 0, result: { ok: true, available: false, session, reason: `screencapture unavailable in this session (launchd session "${session}", exit ${r.status}): ${String(r.stderr || '').trim().slice(0, 200) || 'no output'}` } };
}

// ----------------------------------------------------------------------------------------------- cli
export function cli({ root, passthrough }) {
  const c = spawn(process.execPath, [CLI, ...passthrough, '--root', root], { stdio: 'inherit', env: { ...process.env, CODEX_MODS_ROOT: root } });
  return new Promise((resolve) => c.on('close', (code) => resolve({ code: code ?? 1, result: null })));
}

// ----------------------------------------------------------------------------------------------- control (stock-equivalent copy)
/**
 * Builds a copy of the stock app with NO framework (the loader is the observation prelude and nothing else; the adapter has no
 * transforms), launches it isolated, tries the AppleScript quit, and reports whether the stock app itself refuses.
 */
export async function control({ root }) {
  const P = qaPaths(root);
  const qa = P.qaDir;
  fs.mkdirSync(qa, { recursive: true, mode: 0o700 });
  const stock = '/Applications/ChatGPT.app';
  const info = JSON.parse(sys.run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(stock, 'Contents/Info.plist')]).stdout);
  const build = `${info.CFBundleShortVersionString}-${info.CFBundleVersion}`;
  const adapter = JSON.parse(fs.readFileSync(path.join(CHECKOUT, 'adapters', build, 'adapter.json'), 'utf8'));
  adapter.transforms = [];
  adapter.owl = { ...(adapter.owl ?? { iniPath: 'Resources/owl-app.ini' }), userDataDirectoryName: 'ChatGPT Mods Control' };
  const inputs = path.join(qa, 'control-inputs');
  fs.mkdirSync(inputs, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(inputs, 'adapter.json'), JSON.stringify(adapter, null, 2));
  fs.writeFileSync(path.join(inputs, 'loader.cjs'), diagPrelude({ full: false, control: true }));
  fs.writeFileSync(path.join(inputs, 'relay.sh'), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
  const outDir = path.join(root, 'apps', 'control');
  const b = sys.run(process.execPath, [path.join(CHECKOUT, 'builder', 'build.mjs'), '--stock', stock, '--adapter', path.join(inputs, 'adapter.json'),
    '--loader', path.join(inputs, 'loader.cjs'), '--relay', path.join(inputs, 'relay.sh'), '--root', root, '--identity', '-', '--out', outDir, '--name', 'ChatGPT Mods Control', '--force', '--allow-updater', '--allow-no-isolation-baseline', '--qa-no-restore'], // diagnostics: the control loader is the observation prelude only
  { maxBuffer: 16 * 1024 * 1024 });
  const result = { root, build, builder: { status: b.status, stderr: String(b.stderr).trim().slice(-600) } };
  if (b.status !== 0) { result.ok = false; return { code: 1, result }; }
  const appPath = path.join(outDir, 'ChatGPT Mods Control.app');
  if (owned(root).list.length) { result.ok = false; result.error = 'owned processes already running; run stop first'; return { code: 1, result }; }
  fs.rmSync(path.join(qa, 'diag.log'), { force: true });
  const userData = path.join(root, 'profiles', 'default', 'userData');
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
  result.restoration = restorePolicy(root);
  if (!result.restoration.ok) return { code: 1, result: { ...result, ok: false } };
  const launchId = randomUUID();
  writeJson(launchFile(root), { launchId });
  const t0 = Date.now();
  const o = sys.run('/usr/bin/open', buildOpenArgs(appPath, [`--user-data-dir=${userData}`], { launchId }));
  result.open = { status: o.status, stderr: String(o.stderr).trim() };
  let main; while (!main && Date.now() - t0 < 30000) { main = findMain(owned(root).list); if (!main) await sleep(300); }
  if (!main) { result.ok = false; result.error = 'control app did not start'; return { code: 1, result }; }
  writeJson(launchFile(root), { launchId, pid: main.pid });
  const early = collectIsolation(root, sys.ps(), main.pid, { requireCodexHomeObserved: false, requireUserDataObserved: false, codexHome: 'codex-home', userData: 'profiles/default/userData' });
  if (!early.ok) { result.isolation = early; result.ok = false; result.stopped = (await stop({ root })).result; return { code: 3, result }; }
  await sleep(25000); // let the sign-in window load and the backend start
  { const scan = scanKeychainPrompts({ root, sinceMs: t0, pids: family(sys.ps(), main.pid).map((p) => p.pid) });
    if (!scan.ok || scan.prompts.length) return handleKeychainPrompt({ root, scan, stage: 'control' }); }
  const iso = collectIsolation(root, sys.ps(), main.pid, { requireCodexHomeObserved: true, codexHome: 'codex-home', userData: 'profiles/default/userData' });
  result.isolation = { ok: iso.ok, violations: iso.violations, tree: iso.tree };
  if (!iso.ok) { result.stopped = (await stop({ root })).result; result.ok = false; return { code: 3, result }; }
  result.beforeQuit = { mainAlive: sys.ps().some((p) => p.pid === main.pid), processes: iso.tree.length };
  const script = `tell application "${fs.realpathSync(appPath)}" to quit`;
  const q = sys.run('/usr/bin/osascript', ['-e', script], { timeout: 15000 });
  result.quit = { status: q.status, stderr: String(q.stderr || '').trim().slice(0, 300), stdout: String(q.stdout || '').trim() };
  const tq = Date.now();
  let gone = false; while (Date.now() - tq < 20000) { if (!sys.ps().some((p) => p.pid === main.pid)) { gone = true; break; } await sleep(250); }
  result.quit.mainExited = gone; result.quit.exitedAfterMs = gone ? Date.now() - tq : null;
  result.diagLog = (() => { try { return fs.readFileSync(path.join(qa, 'diag.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return null; } })();
  result.stopped = (await stop({ root })).result;
  result.ok = true;
  writeJson(path.join(qa, 'control-quit.json'), result);
  return { code: 0, result };
}

// ----------------------------------------------------------------------------------------------- probe
/** Sends one JSON command to the running copy's probe (scripts/qa/probe/) and returns its answer. */
export async function probe({ root, command, timeoutMs = 60000 }) {
  const dir = path.join(qaPaths(root).qaDir, 'probe');
  const id = randomUUID();
  fs.mkdirSync(path.join(dir, 'in'), { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, 'in', `${id}.tmp`);
  fs.writeFileSync(tmp, command, { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, 'in', `${id}.json`));
  const out = path.join(dir, 'out', `${id}.json`);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fs.existsSync(out)) { const r = readJson(out); fs.rmSync(out, { force: true }); return { code: r?.ok ? 0 : 1, result: r }; }
    await sleep(200);
  }
  fs.rmSync(path.join(dir, 'in', `${id}.json`), { force: true });
  return { code: 1, result: { id, ok: false, error: `no answer in ${timeoutMs / 1000} s: is the copy running with setup --probe?` } };
}
