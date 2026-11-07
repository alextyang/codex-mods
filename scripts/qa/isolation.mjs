// Pure isolation evaluation from ps eww lines and lsof names (the same rules the builder probes applied).
export const GROUP_CONTAINER = 'Library/Group Containers/2DC432GLL2';
/** The copy's own renamed Computer Use container (every copy renames it through the asar transform plus binary patches, ARCHITECTURE v1.11). */
/** A Computer Use helper process (service, client, guardian, installer). */
export const HELPER_PROCESS = /(SkyComputerUseService|SkyComputerUseClient|CUALockScreenGuardian|Codex Computer Use( Installer)?\.app)/;
// Ad-hoc copies keep OpenAI's prefix; a team-signed copy's container carries its own team id (ARCHITECTURE §5.3).
export const OWN_CONTAINER = /Library\/Group Containers\/[A-Z0-9]{10}\.com\.openai\.sky\.CUAServicf(\/|$)/;
/** Stock (and stock-like) user-data directories under ~/Library/Application Support that a QA profile must never hold open. */
export const STOCK_USER_DATA_NAMES = ['ChatGPT', 'Codex', 'ChatGPT Mods'];

/** Env assignments in a `ps eww` line (command args contain '=' too, but never with a bare identifier before it). */
export function parseEnvLine(line) {
  const env = {};
  for (const m of String(line).matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=(\S*)/g)) env[m[1]] = m[2];
  return env;
}

/** lsof -Fpn output → [{pid, name}] */
export function parseLsofF(text) {
  const out = [];
  let pid = null;
  for (const l of String(text).split('\n')) {
    if (l.startsWith('p')) pid = +l.slice(1); else if (l.startsWith('n') && pid !== null) out.push({ pid, name: l.slice(1) });
  }
  return out;
}

const under = (name, dir) => name === dir || name.startsWith(`${dir.replace(/\/$/, '')}/`);
/** The executable of a ps command line (paths may contain spaces: cut at the first option). */
const executableOf = (command) => String(command ?? '').split(/ -{1,2}[A-Za-z]/)[0].trim();
/** The Computer Use service the app's managed service spawns (`kie`: <helper>/Contents/MacOS/SkyComputerUseService). */
export const HELPER_SERVICE = /\/Contents\/MacOS\/SkyComputerUseService$/;
const isHelperService = (p) => HELPER_SERVICE.test(executableOf(p.command));

/**
 * The private CODEX_HOME of the copy's own relocated helper (ARCHITECTURE §5.3, `cua-helper-private-home`): the profile directory, i.e.
 * the parent of the profile's `computer-use/` directory, for a helper process whose executable lies under that directory. Null for any
 * other process, so the value is never accepted from anything else (the app, the backend, a helper elsewhere).
 */
export function relocatedHelperHome(p, expected) {
  if (!p.command || !HELPER_PROCESS.test(p.command)) return null;
  const exe = executableOf(p.command);
  const dir = (expected.computerUseDirs ?? []).find((d) => under(exe, d) && exe !== d);
  return dir === undefined ? null : dir.replace(/\/+$/, '').replace(/\/[^/]+$/, '');
}

/**
 * @param {{processes: {pid:number, role:string, envLine:string}[], files: {pid:number, name:string}[],
 *          expected: {codexHomes: string[], userDataDirs: string[], home: string, backendDirs?: string[]}, requireCodexHomeObserved?: boolean}} input
 * The loader sets CODEX_HOME in-process, so ps eww shows it on children (backend, relay) but not on the main process; the launch env
 * (CODEX_SPARKLE_ENABLED) is visible on every process.
 */
export function evaluateIsolation({ processes, files, expected, requireCodexHomeObserved = true, requireUserDataObserved = true, requireMockKeychain = true,
  requireSparkleEnv = true, requireSkipCuEnv = true, inspectFailures = [] }) {
  const violations = inspectFailures.map((f) => ({ kind: 'inspect-failed', ...f })); // a failed or empty ps/lsof is never a pass
  let codexHomeSeen = 0;
  let helperHomeSeen = 0;
  const perProcess = processes.map((p) => {
    const env = parseEnvLine(p.envLine);
    const ownHelperHome = relocatedHelperHome(p, expected); // the profile directory when p is the copy's relocated helper, else null
    if ('CODEX_HOME' in env) {
      codexHomeSeen += 1;
      if (ownHelperHome !== null && env.CODEX_HOME === ownHelperHome) helperHomeSeen += 1; // cua-helper-private-home: accepted for the relocated helper only
      // a backend's own home inside the profile (a mod's backend, an added account's: <profile>/backends/...) is the copy's too
      else if (!expected.codexHomes.includes(env.CODEX_HOME) && !(expected.backendDirs ?? []).some((d) => under(env.CODEX_HOME, d) && env.CODEX_HOME !== d)) violations.push({ kind: 'codex-home', pid: p.pid, role: p.role, detail: `CODEX_HOME=${env.CODEX_HOME}` });
    }
    // The service must be the relocated one, started with the private home. Without it the helper falls back to the app's or the default
    // CODEX_HOME and writes its notify line there (on a daily copy: the shared ~/.codex/config.toml).
    if (isHelperService(p) && (ownHelperHome === null || env.CODEX_HOME !== ownHelperHome)) {
      violations.push({ kind: 'helper-home', pid: p.pid, role: p.role,
        detail: ownHelperHome === null ? `not the relocated helper: ${executableOf(p.command)}` : `CODEX_HOME=${env.CODEX_HOME ?? '(unset)'}, expected ${ownHelperHome}` });
    }
    if (p.role === 'app-main' && requireSparkleEnv && env.CODEX_SPARKLE_ENABLED !== 'false') violations.push({ kind: 'sparkle', pid: p.pid, role: p.role, detail: 'CODEX_SPARKLE_ENABLED is not false' });
    if (p.role === 'app-main' && requireMockKeychain && !String(p.envLine).includes(' --use-mock-keychain')) violations.push({ kind: 'mock-keychain', pid: p.pid, role: p.role, detail: 'the main process was not started with --use-mock-keychain' });
    if (p.role === 'app-main' && requireSkipCuEnv && env.CODEX_ELECTRON_SKIP_COMPUTER_USE_CANONICAL_REFRESH !== '1') violations.push({ kind: 'skip-computer-use', pid: p.pid, role: p.role, detail: 'CODEX_ELECTRON_SKIP_COMPUTER_USE_CANONICAL_REFRESH is not 1' });
    return { pid: p.pid, role: p.role, codexHome: env.CODEX_HOME ?? null, sparkle: env.CODEX_SPARKLE_ENABLED ?? null };
  });
  // Computer Use helper processes may only run from the copy's own install (<profile>/computer-use) or the copy's bundle, never stock's
  const allowedHelper = [...(expected.computerUseDirs ?? []), ...(expected.bundleDirs ?? [])];
  let helperProcesses = 0;
  for (const p of processes) {
    if (!p.command || !HELPER_PROCESS.test(p.command)) continue;
    helperProcesses += 1;
    const exe = executableOf(p.command);
    if (!allowedHelper.some((d) => under(exe, d))) violations.push({ kind: 'helper-location', pid: p.pid, role: p.role, detail: exe });
  }
  if (requireCodexHomeObserved && codexHomeSeen === 0) violations.push({ kind: 'codex-home-unobserved', detail: 'no process in the group shows CODEX_HOME' });
  const stockCodex = `${expected.home}/.codex`;
  const stockUserData = STOCK_USER_DATA_NAMES.map((n) => `${expected.home}/Library/Application Support/${n}`);
  const roleByPid = new Map(processes.map((p) => [p.pid, p.role]));
  const isMainOrRenderer = (pid) => { const r = roleByPid.get(pid); return r === 'app-main' || r === 'chromium-renderer'; };
  let userDataFiles = 0;
  let userDataFilesByMainOrRenderer = 0;
  let ownContainerFiles = 0;
  let computerUseFiles = 0;
  const ownContainerSamples = [];
  for (const f of files) {
    const inProfile = expected.userDataDirs.some((d) => under(f.name, d));
    if ((expected.computerUseDirs ?? []).some((d) => under(f.name, d))) { computerUseFiles += 1; continue; } // the profile's own helper install: accepted
    if (OWN_CONTAINER.test(f.name)) { ownContainerFiles += 1; if (ownContainerSamples.length < 3) ownContainerSamples.push(f.name); } // info only
    else if (f.name.includes(GROUP_CONTAINER)) violations.push({ kind: 'group-container', pid: f.pid, detail: f.name });
    else if (under(f.name, stockCodex)) violations.push({ kind: 'home-codex', pid: f.pid, detail: f.name });
    else if (!inProfile && stockUserData.some((d) => under(f.name, d))) violations.push({ kind: 'stock-user-data', pid: f.pid, detail: f.name });
    if (inProfile) { userDataFiles += 1; if (isMainOrRenderer(f.pid)) userDataFilesByMainOrRenderer += 1; }
  }
  if (requireUserDataObserved && userDataFilesByMainOrRenderer === 0) violations.push({ kind: 'user-data-unobserved', detail: `no open file under the profile userData (${expected.userDataDirs.join(' | ')}) by the main or a renderer process` });
  return { ok: violations.length === 0, violations, processes: perProcess, files: files.length, userDataFiles, userDataFilesByMainOrRenderer, codexHomeProcesses: codexHomeSeen,
    info: { ...(ownContainerFiles ? { 'own-container': { files: ownContainerFiles, samples: ownContainerSamples } } : {}), ...(computerUseFiles || helperProcesses ? { 'computer-use': { files: computerUseFiles, processes: helperProcesses, privateHome: helperHomeSeen } } : {}) } };
}
