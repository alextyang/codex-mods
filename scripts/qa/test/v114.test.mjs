import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseQaArgs, QaUsageError, buildOpenArgs, launchEnvFor, SPARKLE_ENV, SKIP_CU_ENV } from '../args.mjs';
import { evaluateIsolation } from '../isolation.mjs';
import { updaterViolations } from '../updater.mjs';
import { withProfileGuard } from '../commands.mjs';

test('launch flags: --cu-refresh, --noenv, --guard are launch-only', () => {
  const p = parseQaArgs(['launch', '--cu-refresh', '--noenv', '--guard', '--root', '/r']);
  assert.deepEqual([p.cuRefresh, p.noenv, p.guard], [true, true, true]);
  assert.deepEqual([parseQaArgs(['launch', '--root', '/r']).cuRefresh, parseQaArgs(['launch', '--root', '/r']).noenv, parseQaArgs(['launch', '--root', '/r']).guard], [false, false, false]);
  for (const f of ['--cu-refresh', '--noenv', '--guard']) assert.throws(() => parseQaArgs(['stop', f, '--root', '/r']), QaUsageError, f);
});

test('launch environment per mode: strict by default; --cu-refresh drops only the skip variable; --noenv drops both; mock keychain and user-data-dir stay', () => {
  assert.deepEqual(launchEnvFor(), [SPARKLE_ENV, SKIP_CU_ENV]);
  assert.deepEqual(launchEnvFor({ cuRefresh: true }), [SPARKLE_ENV]);
  assert.deepEqual(launchEnvFor({ noenv: true }), []);
  assert.deepEqual(launchEnvFor({ noenv: true, cuRefresh: true }), []);
  const env = (m) => buildOpenArgs('/a.app', ['--user-data-dir=/u'], m).filter((x, i, arr) => arr[i - 1] === '--env');
  assert.deepEqual(env({}), [SPARKLE_ENV, SKIP_CU_ENV]);
  assert.deepEqual(env({ cuRefresh: true }), [SPARKLE_ENV]);
  assert.deepEqual(env({ noenv: true }), []);
  for (const m of [{}, { cuRefresh: true }, { noenv: true }]) {
    const args = buildOpenArgs('/a.app', ['--user-data-dir=/u'], m);
    assert.deepEqual(args.slice(args.indexOf('--args')), ['--args', '--user-data-dir=/u', '--use-mock-keychain', '-ApplePersistenceIgnoreState', 'YES', '-NSDisablePersistence', 'YES', '-NSQuitAlwaysKeepsWindows', 'NO']);
  }
});

const HOME = '/Users/qauser';
const EXP = { codexHomes: ['/q/ch'], userDataDirs: ['/q/ud'], home: HOME, computerUseDirs: ['/q/profiles/default/computer-use'], bundleDirs: ['/q/apps'] };
const MAIN_FULL = 'x --use-mock-keychain CODEX_SPARKLE_ENABLED=false CODEX_ELECTRON_SKIP_COMPUTER_USE_CANONICAL_REFRESH=1 CODEX_HOME=/q/ch';
const MAIN_NO_SKIP = 'x --use-mock-keychain CODEX_SPARKLE_ENABLED=false CODEX_HOME=/q/ch';
const MAIN_NONE = 'x --use-mock-keychain CODEX_HOME=/q/ch';
const run = (envLine, opts = {}, procs = [], files = []) => evaluateIsolation({ expected: EXP,
  processes: [{ pid: 1, role: 'app-main', envLine, command: '/q/apps/b/ChatGPT Mods QA.app/Contents/MacOS/ChatGPT' }, ...procs], files: [{ pid: 1, name: '/q/ud/Cookies' }, ...files], ...opts });
const kinds = (r) => r.violations.map((v) => v.kind);

test('D3 (m3 session 2): the copy\'s own relocated helper with the profile directory as CODEX_HOME passes every check; nothing else gets that value', () => {
  // The observed process: started by app-main ~7 s after launch with CODEX_HOME=<profile> (cua-helper-private-home), run from <profile>/computer-use.
  const svc = (envLine, exe = '/q/profiles/default/computer-use/Codex Computer Use.app') => ({ pid: 37195, role: 'SkyComputerUseService', envLine, command: `${exe}/Contents/MacOS/SkyComputerUseService` });
  const observed = svc('/q/profiles/default/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService CODEX_HOME=/q/profiles/default CODEX_MODS_COMPUTER_USE_DIR=/q/profiles/default/computer-use CODEX_SPARKLE_ENABLED=false');
  const r = run(MAIN_FULL, {}, [observed], [{ pid: 37195, name: '/q/profiles/default/config.toml' }]);
  assert.deepEqual(kinds(r), [], 'the +20 s check refused exactly this before the fix (codex-home)');
  assert.equal(r.info['computer-use'].privateHome, 1);
  // the same value on anything else is refused
  assert.deepEqual(kinds(run(MAIN_FULL, {}, [{ pid: 9, role: 'backend', envLine: 'x CODEX_HOME=/q/profiles/default', command: '/q/apps/b/ChatGPT Mods QA.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server' }])), ['codex-home']);
  // another profile's directory, the QA root, or ~/.codex on the relocated helper is refused
  for (const home of ['/q/profiles/other', '/q', `${HOME}/.codex`]) assert.deepEqual(kinds(run(MAIN_FULL, {}, [svc(`x CODEX_HOME=${home}`)])), ['codex-home', 'helper-home'], home);
  // the relocated service without the private home (the edit's 500 ms bound passed, or a LaunchServices start) is refused
  assert.deepEqual(kinds(run(MAIN_FULL, {}, [svc('x')])), ['helper-home']);
  assert.deepEqual(kinds(run(MAIN_FULL, {}, [svc('x CODEX_HOME=/q/ch')])), ['helper-home'], 'the app\'s own CODEX_HOME leaked to the helper');
});

test('isolation modes: the launch-env assertions are dropped only for the variables the mode omits', () => {
  assert.deepEqual(kinds(run(MAIN_FULL)), []);
  assert.deepEqual(kinds(run(MAIN_NO_SKIP)), ['skip-computer-use'], 'strict by default');
  assert.deepEqual(kinds(run(MAIN_NO_SKIP, { requireSkipCuEnv: false })), [], '--cu-refresh');
  assert.deepEqual(kinds(run(MAIN_NONE)), ['sparkle', 'skip-computer-use']);
  assert.deepEqual(kinds(run(MAIN_NONE, { requireSparkleEnv: false, requireSkipCuEnv: false })), [], '--noenv');
  assert.deepEqual(kinds(run(MAIN_NONE, { requireSparkleEnv: false })), ['skip-computer-use'], 'only the sparkle assertion is dropped');
  assert.deepEqual(kinds(run(MAIN_NO_SKIP.replace(' --use-mock-keychain', ''), { requireSkipCuEnv: false })), ['mock-keychain'], 'mock keychain is always required');
});

test('--cu-refresh: the helper is accepted under the profile computer-use dir and nowhere else', () => {
  const helper = (exe, envLine = 'x CODEX_HOME=/q/profiles/default') => [{ pid: 7, role: 'SkyComputerUseService', envLine, command: `${exe}/Contents/MacOS/SkyComputerUseService` }];
  const own = '/q/profiles/default/computer-use/Codex Computer Use.app';
  const r = run(MAIN_NO_SKIP, { requireSkipCuEnv: false }, helper(own), [{ pid: 7, name: `${own}/Contents/Resources/x.db` }, { pid: 7, name: '/q/profiles/default/computer-use/config.json' }]);
  assert.deepEqual(kinds(r), []);
  assert.deepEqual(r.info['computer-use'], { files: 2, processes: 1, privateHome: 1 });
  for (const bad of ['/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app', `${HOME}/.codex/computer-use/Codex Computer Use.app`, '/q/apps2/x/Codex Computer Use.app']) {
    assert.deepEqual(kinds(run(MAIN_NO_SKIP, { requireSkipCuEnv: false }, helper(bad))), ['codex-home', 'helper-home', 'helper-location'], bad);
    assert.deepEqual(kinds(run(MAIN_NO_SKIP, { requireSkipCuEnv: false }, helper(bad, 'x'))), ['helper-home', 'helper-location'], bad);
  }
  // the copy's bundle copy of a helper is an allowed location, but the service must be the relocated one (cua-relocate-dir)
  const bundled = '/q/apps/b/ChatGPT Mods QA.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app';
  assert.deepEqual(kinds(run(MAIN_FULL, {}, [{ pid: 8, role: 'SkyComputerUseClient', envLine: 'x CODEX_HOME=/q/ch', command: `${bundled}/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient turn-ended` }])), []);
  assert.deepEqual(kinds(run(MAIN_FULL, {}, helper(bundled))), ['codex-home', 'helper-home']);
  // writes under ~/.codex/computer-use, the stock Group Container and other containers still fail
  const v = kinds(run(MAIN_NO_SKIP, { requireSkipCuEnv: false }, [], [{ pid: 7, name: `${HOME}/.codex/computer-use/x` }, { pid: 7, name: `${HOME}/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/y` }, { pid: 7, name: `${HOME}/Library/Group Containers/2DC432GLL2.com.openai.shared/z` }]));
  assert.deepEqual(v, ['home-codex', 'group-container', 'group-container']);
});

test('--noenv: updater processes and appcast/updater log lines are violations; ordinary lines are not', () => {
  assert.deepEqual(updaterViolations({ processes: [{ pid: 1, command: '/q/apps/b/ChatGPT Mods QA.app/Contents/MacOS/ChatGPT' }, { pid: 2, command: '/x/Codex Framework/Helpers/Codex (Service).app/Contents/MacOS/Codex (Service) --type=utility' }], logs: [{ file: 'a.log', lines: ['info [window-manager] window ready-to-show', 'info [bundled-plugins] reconcile skipped'] }] }), []);
  const bad = updaterViolations({ processes: [{ pid: 9, command: '/q/apps/b/ChatGPT Mods QA.app/Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate -x' }],
    logs: [{ file: 'main.log', lines: ['info [sparkle] checking for updates', 'info fetching appcast https://example.invalid/appcast.xml', 'warn SUFeedURL missing'] }] });
  assert.deepEqual(bad.map((x) => x.kind), ['updater-process', 'updater-log', 'updater-log', 'updater-log']);
});

test('--guard: guardStockApp is forced on for the launch only; profile.json is restored byte for byte, also when the launch throws', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-guard-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'profile.json');
  const original = '{\n  "codexHome": "/q/ch",\n  "guardStockApp": false,\n  "extra": [1,2]\n}\n';
  fs.writeFileSync(file, original);
  let during = null;
  const { value, guard } = await withProfileGuard(file, async () => { during = JSON.parse(fs.readFileSync(file, 'utf8')); return 'launched'; });
  assert.equal(value, 'launched');
  assert.deepEqual([during.guardStockApp, during.codexHome, during.extra], [true, '/q/ch', [1, 2]]);
  assert.deepEqual(guard, { enabledForThisLaunch: true, originalGuardStockApp: false, restored: true });
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  await assert.rejects(withProfileGuard(file, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(fs.readFileSync(file, 'utf8'), original, 'restored after a failure');
  fs.writeFileSync(file, '{"guardStockApp":true}');
  assert.equal((await withProfileGuard(file, async () => 1)).guard.originalGuardStockApp, true);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"guardStockApp":true}');
});
