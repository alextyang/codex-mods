// Pure argument handling for scripts/qa.mjs.
import path from 'node:path';
import { RESTORATION_ARGS, LAUNCH_ID_ENV } from './restoration.mjs';
import { layout, SOCKETS } from '../../contracts/layout.mjs';

export const COMMANDS = ['setup', 'launch', 'status', 'screenshot', 'stop', 'cli', 'control', 'probe'];
/** QA-only probes under scripts/qa/probe/ that `setup --probe <name>` may prepend to the copy's loader. */
export const PROBES = ['native'];
export const APP_NAME = 'ChatGPT Mods QA.app';
export const USAGE = `node scripts/qa.mjs <command> --root <short QA root> [--json]    (run as UID503)

  setup               create the QA profile (real "codexmods setup"), install this checkout, build the copy
  launch [--keep] [--fast] [--cu-refresh] [--noenv] [--guard]   open the QA copy isolated, wait for readiness, run the isolation checks, write qa/last-launch.json (--fast skips the +20 s / +45 s post-sign-in isolation re-checks;
                      --cu-refresh lets the first-boot Computer Use helper install happen (helper accepted only under the profile's computer-use dir);
                      --noenv omits CODEX_SPARKLE_ENABLED and the skip variable, and asserts no updater process/appcast fetch instead;
                      --guard turns the profile's stock/CLI concurrency guard on for this launch only)
  status              management diagnostics, mods.list, compat.report, updates.status
  screenshot <name>   screencapture -x into <root>/qa/shots/<name>.png (reports "unavailable" without a GUI session)
  stop                graceful quit, then SIGTERM, then SIGKILL; verify nothing owned remains
  cli <args...>       run cli/codexmods.mjs against the QA root (--root is consumed here; other flags pass through)

Diagnostics (test builds only, never product):
  setup --stock <app> build from this stock app (a clone under the root; recorded in the profile) instead of the installed one
  setup --rebuild     force a fresh copy (a -r<N> directory when the matching one is current or the LKG), then repoint the launch symlink
  setup --diag        like setup, but the copy's loader gets scripts/qa/diag/prelude.cjs prepended (logs to <root>/qa/diag.log)
  setup --identity <name>  like setup, signed with that identity (without it, the profile keeps the identity it has; ad-hoc for a new one) (from the QA user's qa-signing keychain, see
                      scripts/qa/signing-keychain.sh) instead of ad-hoc; only team-signed copies can run Computer Use
  setup --probe <name>  like setup, but the copy's loader gets scripts/qa/probe/<name>.cjs prepended (names: native); combines with --diag
  probe '<json>'      send one command to the running copy's probe (<root>/qa/probe/in) and print its answer; waits up to 60 s
  control             build + launch a stock-equivalent copy (no framework, observation prelude only), try the AppleScript quit, report

Exit codes: 0 ok, 1 failure, 2 usage / Host not running, 3 isolation violation.`;

export class QaUsageError extends Error { constructor(m) { super(m); this.name = 'QaUsageError'; } }

/** @returns {{command: string, root: string, json: boolean, keep: boolean, positionals: string[], passthrough: string[]}} */
export function parseQaArgs(argv) {
  const args = [...argv];
  if (!args.length || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') return { command: 'help', root: '', json: false, keep: false, diag: false, probe: null, identity: null, rebuild: false, fast: false, cuRefresh: false, noenv: false, guard: false, positionals: [], passthrough: [] };
  const command = args.shift();
  if (!COMMANDS.includes(command)) throw new QaUsageError(`unknown command "${command}"`);
  let root; let json = false; let keep = false; let diag = false; let probe = null; let identity = null; let stock = null; let rebuild = false; let fast = false; let cuRefresh = false; let noenv = false; let guard = false;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--root') { root = args[++i]; if (root === undefined) throw new QaUsageError('--root needs a value'); } else if (a.startsWith('--root=')) root = a.slice(7);
    else if (command !== 'cli' && a === '--json') json = true;
    else if (command === 'launch' && a === '--keep') keep = true;
    else if (command === 'launch' && a === '--fast') fast = true;
    else if (command === 'launch' && a === '--cu-refresh') cuRefresh = true;
    else if (command === 'launch' && a === '--noenv') noenv = true;
    else if (command === 'launch' && a === '--guard') guard = true;
    else if (command === 'setup' && a === '--diag') diag = true;
    else if (command === 'setup' && a === '--identity') { identity = args[++i]; if (!identity || identity.startsWith('--')) throw new QaUsageError('--identity needs a signing identity name'); }
    else if (command === 'setup' && a === '--probe') { probe = args[++i]; if (!PROBES.includes(probe)) throw new QaUsageError(`--probe needs one of ${PROBES.join(', ')}`); }
    else if (command === 'setup' && a === '--rebuild') rebuild = true;
    else if (command === 'setup' && a === '--stock') { stock = args[++i]; if (!stock || stock.startsWith('--') || !path.isAbsolute(stock)) throw new QaUsageError('--stock needs an absolute path to an app'); }
    else rest.push(a);
  }
  if (command === 'cli' && rest.includes('--json')) json = true;
  if (!root) throw new QaUsageError('--root <dir> is required');
  if (!path.isAbsolute(root)) throw new QaUsageError('--root must be an absolute path');
  root = path.resolve(root);
  if (command === 'cli') return { command, root, json, keep, diag, probe, identity, rebuild, fast, cuRefresh, noenv, guard, positionals: [], passthrough: rest };
  const flags = rest.filter((a) => a.startsWith('-'));
  if (flags.length) throw new QaUsageError(`unknown option ${flags[0]}`);
  if (command === 'screenshot') {
    if (rest.length !== 1) throw new QaUsageError('screenshot needs exactly one <name>');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(rest[0])) throw new QaUsageError('screenshot name must match [A-Za-z0-9._-]+');
  } else if (command === 'probe') {
    if (rest.length !== 1) throw new QaUsageError("probe needs exactly one '<json>' command");
    try { if (typeof JSON.parse(rest[0])?.op !== 'string') throw new Error('no op'); } catch { throw new QaUsageError('probe command must be a JSON object with an "op"'); }
  } else if (rest.length) throw new QaUsageError(`unexpected argument "${rest[0]}"`);
  // A QA copy reads its stock only, and only the installed app or a clone under its own root
  if (stock && path.resolve(stock) !== '/Applications/ChatGPT.app' && !path.resolve(stock).startsWith(`${root}/`)) throw new QaUsageError('--stock must be the installed app or a clone under --root');
  return { command, root, json, keep, diag, probe, identity, stock, rebuild, fast, cuRefresh, noenv, guard, positionals: rest, passthrough: [] };
}

/** Refuse roots that could touch real state, and roots too long for the Unix socket names (sun_path is 104 bytes). */
export function validateRoot(root, { home }) {
  const bad = (m) => { throw new QaUsageError(m); };
  const r = path.resolve(root);
  const inside = (a, b) => a === b || a.startsWith(b.endsWith('/') ? b : `${b}/`);
  if (['/', '/System', '/Library', '/usr', '/bin', '/sbin', '/etc', '/var', '/private', '/Users'].includes(r) || inside(r, '/Applications') || inside(r, '/System')) bad(`unsafe --root ${r}`);
  if (r === home || inside(r, path.join(home, '.codex')) || inside(r, path.join(home, 'Library', 'Group Containers')) || inside(r, path.join(home, 'Library', 'Application Support', 'Codex'))) bad(`unsafe --root ${r}`);
  const longest = path.join(layout(r).run, SOCKETS.clients);
  if (Buffer.byteLength(longest) > 100) bad(`--root is too long: ${longest} would exceed the 104-byte socket path limit; use a short root such as ~/cmq`);
  return r;
}

export const qaPaths = (root) => {
  const lay = layout(root);
  return { layout: lay, qaDir: path.join(root, 'qa'), shots: path.join(root, 'qa', 'shots'), lastLaunch: path.join(root, 'qa', 'last-launch.json'),
    lastStop: path.join(root, 'qa', 'last-stop.json'), appPath: path.join(root, APP_NAME), bootMarker: path.join(lay.flags, 'boot.json'),
    previousApp: path.join(root, 'qa', 'previous-app') };   // the launch target a rebuild replaced (text: absolute .app path)
};

/** Launch environment (visible to `ps eww` on every process): no self-update, and the runbook switch that skips the Computer Use canonical refresh. */
/** Chromium switch the OSCrypt key getter in Owl consults (base::CommandLine::HasSwitch): selects an in-memory keychain, no Security.framework call. */
export const MOCK_KEYCHAIN_SWITCH = '--use-mock-keychain';
export const LAUNCH_ENV = ['CODEX_SPARKLE_ENABLED=false', 'CODEX_ELECTRON_SKIP_COMPUTER_USE_CANONICAL_REFRESH=1'];

/** Variables that `--noenv` / `--cu-refresh` leave out of the launch environment. */
export const SPARKLE_ENV = 'CODEX_SPARKLE_ENABLED=false';
export const SKIP_CU_ENV = 'CODEX_ELECTRON_SKIP_COMPUTER_USE_CANONICAL_REFRESH=1';
/** Launch environment for a mode: default both; --cu-refresh omits the Computer Use skip; --noenv omits both. */
export function launchEnvFor({ cuRefresh = false, noenv = false } = {}) {
  return LAUNCH_ENV.filter((e) => !(noenv) && !(cuRefresh && e === SKIP_CU_ENV));
}

/** `open` argv: new instance, env on the launch (visible to ps eww), then the launch args exactly as recorded in profile.json. */
export function buildOpenArgs(appPath, launchArgs, mode = {}) {
  const args = [...(launchArgs ?? [])];
  if (!args.includes(MOCK_KEYCHAIN_SWITCH)) args.push(MOCK_KEYCHAIN_SWITCH); // QA never touches the real Keychain (builder/KEYCHAIN.md)
  return ['-n', '-g', '-F', ...launchEnvFor(mode).flatMap((e) => ['--env', e]),
    ...(mode.launchId ? ['--env', `${LAUNCH_ID_ENV}=${mode.launchId}`] : []), appPath, '--args', ...args, ...RESTORATION_ARGS];
}

/**
 * Where a forced rebuild goes. The matching apps/<base> is deleted and rebuilt in place only when it is not protected
 * (protectedAppDirs); otherwise the first unused <base>-r<N>.
 * @param {{base: string, exists: (name: string) => boolean, isProtected: (name: string) => boolean}} i
 * @returns {{name: string, deleteExisting: boolean, reason?: string}}
 */
export function planRebuildDir({ base, exists, isProtected }) {
  if (!exists(base)) return { name: base, deleteExisting: false };
  if (!isProtected(base)) return { name: base, deleteExisting: true };
  let n = 1; while (exists(`${base}-r${n}`)) n += 1;
  return { name: `${base}-r${n}`, deleteExisting: false, reason: 'the matching copy is protected (the launch target, the previous target, the LKG or a boot record\'s copy)' };
}

/**
 * Directories under apps/ that a rebuild or prune must not delete: the one holding the current launch-symlink target, the one named in
 * the profile's lkg-app file (layout.lkgApp, v1.6), the previous launch target a rebuild recorded in qa/previous-app, and every copy a
 * boot record names (generations/<n>.json appCandidate). All values are absolute paths of an .app inside <apps>/<dir>/.
 * @param {{symlinkTarget?: string|null, lkgAppText?: string|null, previousAppText?: string|null, generationApps?: string[], realpath?: (p: string) => string}} i
 * @returns {Set<string>} realpath'd directories
 */
export function protectedAppDirs({ symlinkTarget, lkgAppText, previousAppText, generationApps = [], realpath = (p) => p }) {
  const out = new Set();
  for (const app of [symlinkTarget, lkgAppText?.trim(), previousAppText?.trim(), ...generationApps]) if (app) out.add(path.dirname(realpath(app)));
  return out;
}

/**
 * The superseded copies of `build`: every apps/<build>-<hash> that is not protected, not used by a running process and not an
 * unfinished build that may still be in progress. Copies of other builds are never superseded, because a build whose stock app is
 * gone cannot be rebuilt.
 * @param {{build: string, names: string[], isProtected: (name: string) => boolean, inUse?: (name: string) => boolean, unfinished?: (name: string) => boolean}} i
 * @returns {string[]} directory names, sorted
 */
export function supersededCopies({ build, names, isProtected, inUse = () => false, unfinished = () => false, stale = () => false }) {
  // this build's, and another build's no record names that has not been used for a while (`stale`: each copy is about 1.7 GB)
  return names.filter((n) => (n.startsWith(`${build}-`) || stale(n)) && !isProtected(n) && !inUse(n) && !unfinished(n)).sort();
}

/**
 * The superseded framework versions under <root>/framework: each setup installs the checkout as a new version (about 7 MB), so every
 * version goes but those a pointer (current, previous, lkg) or a boot record names and the `newest` most recently installed.
 * @param {{names: string[], kept: Set<string>, mtime: (name: string) => number, newest?: number}} i
 * @returns {string[]} directory names, sorted
 */
export function supersededFrameworks({ names, kept, mtime, newest = 3 }) {
  const versions = names.filter((n) => !['current', 'previous', 'lkg'].includes(n) && !n.startsWith('.'));
  const recent = new Set([...versions].sort((a, b) => mtime(b) - mtime(a)).slice(0, newest));
  return versions.filter((n) => !kept.has(n) && !recent.has(n)).sort();
}
