import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseQaArgs, validateRoot, QaUsageError, buildOpenArgs, qaPaths, planRebuildDir, protectedAppDirs, supersededCopies, supersededFrameworks, LAUNCH_ENV } from '../args.mjs';
import { pruneSupersededCopies, clearCopyTempFiles } from '../commands.mjs';
import { parsePs, ownedProcesses, family, findMain, roleOf, selfAndAncestors, signalTargets, modCopyRunning, copyTempFiles } from '../procs.mjs';
import { parseEnvLine, parseLsofF, evaluateIsolation } from '../isolation.mjs';
import { evaluateReadiness } from '../readiness.mjs';
import { parsePromptLog, matchPrompts, logShowArgs, logTime, parseLogTime, selectSecurityAgents, dismissSecurityAgents, PROMPT_PREDICATE, EXIT_PROMPT, ERROR_PROMPT } from '../keychain.mjs';

test('arguments: commands, root, json, keep, passthrough', () => {
  assert.equal(parseQaArgs([]).command, 'help');
  assert.deepEqual(parseQaArgs(['stop', '--root', '/Users/x/cmq', '--json']), { command: 'stop', root: '/Users/x/cmq', json: true, keep: false, diag: false, probe: null, identity: null, stock: null, rebuild: false, fast: false, cuRefresh: false, noenv: false, guard: false, positionals: [], passthrough: [] });
  assert.equal(parseQaArgs(['launch', '--root=/Users/x/cmq', '--keep']).keep, true);
  assert.equal(parseQaArgs(['setup', '--diag', '--root', '/r']).diag, true);
  assert.equal(parseQaArgs(['setup', '--rebuild', '--root', '/r']).rebuild, true);
  assert.throws(() => parseQaArgs(['launch', '--rebuild', '--root', '/r']), QaUsageError);
  assert.throws(() => parseQaArgs(['launch', '--diag', '--root', '/r']), QaUsageError);
  assert.equal(parseQaArgs(['control', '--root', '/r']).command, 'control');
  assert.equal(parseQaArgs(['setup', '--probe', 'native', '--diag', '--root', '/r']).probe, 'native');
  assert.equal(parseQaArgs(['setup', '--identity', 'Apple Development: QA (TEAM123456)', '--root', '/r']).identity, 'Apple Development: QA (TEAM123456)');
  assert.equal(parseQaArgs(['setup', '--root', '/r']).identity, null);
  assert.equal(parseQaArgs(['setup', '--stock', '/r/qa/stock/ChatGPT.app', '--root', '/r']).stock, '/r/qa/stock/ChatGPT.app', 'a clone under the root (E5)');
  assert.equal(parseQaArgs(['setup', '--stock', '/Applications/ChatGPT.app', '--root', '/r']).stock, '/Applications/ChatGPT.app');
  for (const bad of [['setup', '--stock', '/Users/x/ChatGPT.app', '--root', '/r'], ['setup', '--stock', 'rel/ChatGPT.app', '--root', '/r'], ['launch', '--stock', '/r/x.app', '--root', '/r']]) assert.throws(() => parseQaArgs(bad), QaUsageError, bad.join(' '));
  for (const bad of [['setup', '--identity', '--root', '/r'], ['launch', '--identity', 'x', '--root', '/r']]) assert.throws(() => parseQaArgs(bad), QaUsageError, bad.join(' '));
  assert.deepEqual(parseQaArgs(['probe', '{"op":"views"}', '--root', '/r']).positionals, ['{"op":"views"}']);
  for (const bad of [['setup', '--probe', 'nope', '--root', '/r'], ['setup', '--probe', '--root', '/r'], ['launch', '--probe', 'native', '--root', '/r'], ['probe', '--root', '/r'], ['probe', 'notjson', '--root', '/r'], ['probe', '{"x":1}', '--root', '/r']]) {
    assert.throws(() => parseQaArgs(bad), QaUsageError, bad.join(' '));
  }
  const s = parseQaArgs(['screenshot', 'first-run', '--root', '/r']);
  assert.deepEqual(s.positionals, ['first-run']);
  const c = parseQaArgs(['cli', 'mods', 'list', '--json', '--root', '/r']);
  assert.deepEqual(c.passthrough, ['mods', 'list', '--json']);
  assert.equal(c.json, true);
  for (const bad of [['bogus', '--root', '/r'], ['stop'], ['stop', '--root', 'rel'], ['stop', '--root'], ['screenshot', '--root', '/r'], ['screenshot', '../x', '--root', '/r'], ['stop', '--root', '/r', '--weird'], ['setup', 'extra', '--root', '/r']]) {
    assert.throws(() => parseQaArgs(bad), QaUsageError, bad.join(' '));
  }
});

test('root validation: unsafe and too-long roots are refused', () => {
  const home = '/Users/qauser';
  assert.equal(validateRoot('/Users/qauser/cmq', { home }), '/Users/qauser/cmq');
  for (const bad of ['/', home, '/Applications/ChatGPT.app', '/Users/qauser/.codex', '/Users/qauser/.codex/x', '/Users/qauser/Library/Group Containers/2DC432GLL2', '/Users/qauser/Library/Application Support/Codex', '/var']) {
    assert.throws(() => validateRoot(bad, { home }), QaUsageError, bad);
  }
  assert.throws(() => validateRoot(`/Users/qauser/${'a'.repeat(80)}`, { home }), /too long/);
});

test('open argv: new instance, launch env, launch args after --args', () => {
  assert.deepEqual(buildOpenArgs('/r/ChatGPT Mods QA.app', ['--user-data-dir=/r/u']), ['-n', '-g', '-F', '--env', 'CODEX_SPARKLE_ENABLED=false', '--env', 'CODEX_ELECTRON_SKIP_COMPUTER_USE_CANONICAL_REFRESH=1', '/r/ChatGPT Mods QA.app', '--args', '--user-data-dir=/r/u', '--use-mock-keychain', '-ApplePersistenceIgnoreState', 'YES', '-NSDisablePersistence', 'YES', '-NSQuitAlwaysKeepsWindows', 'NO']);
  assert.deepEqual(buildOpenArgs('/a.app', []), ['-n', '-g', '-F', '--env', 'CODEX_SPARKLE_ENABLED=false', '--env', 'CODEX_ELECTRON_SKIP_COMPUTER_USE_CANONICAL_REFRESH=1', '/a.app', '--args', '--use-mock-keychain', '-ApplePersistenceIgnoreState', 'YES', '-NSDisablePersistence', 'YES', '-NSQuitAlwaysKeepsWindows', 'NO']);
  assert.equal(qaPaths('/r').appPath, '/r/ChatGPT Mods QA.app');
});

const PS = `
    1     0     1 /sbin/launchd
  100     1   100 /usr/sbin/sshd
  200   100   200 node scripts/qa.mjs stop --root /Users/x/cmq
  300     1   300 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT
  301   300   300 /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server
  400     1   400 /private/Users/x/cmq/apps/b-1/ChatGPT Mods QA.app/Contents/MacOS/ChatGPT --user-data-dir=/Users/x/cmq/profiles/default/userData
  401   400   400 /Users/x/cmq/apps/b-1/ChatGPT Mods QA.app/Contents/Frameworks/Codex Framework.framework/Helpers/H.app/Contents/MacOS/H --type=renderer
  402   400   400 /Users/x/cmq/apps/b-1/ChatGPT Mods QA.app/Contents/Resources/cua_node/bin/node /Users/x/cmq/framework/1/framework/host/main.mjs
  403   400   400 /Users/x/cmq/apps/b-1/ChatGPT Mods QA.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex -c a=b app-server
  404   402   404 sleep 100
  500   100   500 /opt/homebrew/bin/node /w/cli/codexmods.mjs mods list --root /Users/x/cmq
`;
test('process table: owned = command mentions the root; the stock app and the harness are never owned', () => {
  const rows = parsePs(PS);
  const ex = selfAndAncestors(rows, 200);
  assert.deepEqual([...ex].sort((a, b) => a - b), [1, 100, 200]);
  const o = ownedProcesses(rows, ['/Users/x/cmq'], ex).map((r) => r.pid);
  assert.deepEqual(o, [400, 401, 402, 403]);
  assert.ok(!o.includes(300) && !o.includes(301), 'stock app untouched');
  assert.ok(!o.includes(500), 'the cli harness is excluded');
  // the realpath spelling is matched too (a main process command line has no --user-data-dir in this row)
  const bare = parsePs('  600     1   600 /private/var/q/cmq/apps/b-1/ChatGPT Mods QA.app/Contents/MacOS/ChatGPT');
  assert.equal(ownedProcesses(bare, ['/var/q/cmq'], new Set()).length, 1, 'substring of the realpath spelling');
  assert.equal(ownedProcesses(bare, ['/Users/x/cmq'], new Set()).length, 0);
  assert.equal(ownedProcesses(bare, ['/Users/x/cmq', '/private/var/q/cmq'], new Set()).length, 1);
  assert.equal(findMain(ownedProcesses(rows, ['/private/Users/x/cmq'], ex)).pid, 400);
  assert.deepEqual(family(rows, 400).map((r) => r.pid).sort(), [400, 401, 402, 403, 404]);
  assert.equal(roleOf(rows.find((r) => r.pid === 402).command), 'host-node');
  assert.equal(roleOf(rows.find((r) => r.pid === 403).command), 'backend');
  assert.equal(roleOf(rows.find((r) => r.pid === 401).command), 'chromium-renderer');
});

const EXPECT = { codexHomes: ['/q/profiles/default/codex-home'], userDataDirs: ['/q/profiles/default/userData'], home: '/Users/qauser' };
const mainEnv = 'PID TTY STAT /q/apps/x/ChatGPT Mods QA.app/Contents/MacOS/ChatGPT --user-data-dir=/q/u --use-mock-keychain TMPDIR=/tmp/ CODEX_SPARKLE_ENABLED=false CODEX_ELECTRON_SKIP_COMPUTER_USE_CANONICAL_REFRESH=1 HOME=/Users/qauser';
const backendEnv = '9 ?? S /q/codex -c features.code_mode_host=true app-server CODEX_SPARKLE_ENABLED=false CODEX_HOME=/q/profiles/default/codex-home';
test('isolation: env parsing ignores command-line "=" tokens', () => {
  const e = parseEnvLine(backendEnv);
  assert.equal(e.CODEX_HOME, '/q/profiles/default/codex-home');
  assert.equal(e.CODEX_SPARKLE_ENABLED, 'false');
  assert.equal('features.code_mode_host' in e, false);
  assert.deepEqual(parseLsofF('p1\nn/a\nn/b\np2\nn/c\n'), [{ pid: 1, name: '/a' }, { pid: 1, name: '/b' }, { pid: 2, name: '/c' }]);
});
test('isolation: a clean group passes; each violation kind is caught', () => {
  const ok = evaluateIsolation({ processes: [{ pid: 1, role: 'app-main', envLine: mainEnv }, { pid: 2, role: 'backend', envLine: backendEnv }],
    files: [{ pid: 1, name: '/q/profiles/default/userData/Cookies' }, { pid: 2, name: '/usr/lib/dyld' }], expected: EXPECT });
  assert.equal(ok.ok, true);
  assert.equal(ok.userDataFiles, 1);
  assert.equal(ok.codexHomeProcesses, 1);
  const kinds = (i) => evaluateIsolation({ expected: EXPECT, requireUserDataObserved: false, ...i }).violations.map((v) => v.kind);
  const base = { processes: [{ pid: 1, role: 'app-main', envLine: mainEnv }, { pid: 2, role: 'backend', envLine: backendEnv }], files: [] };
  assert.deepEqual(kinds({ ...base, files: [{ pid: 2, name: '/Users/qauser/Library/Group Containers/2DC432GLL2/x.db' }] }), ['group-container']);
  assert.deepEqual(kinds({ ...base, files: [{ pid: 2, name: '/Users/qauser/.codex/auth.json' }] }), ['home-codex']);
  assert.deepEqual(kinds({ ...base, files: [{ pid: 2, name: '/Users/qauser/.codexother/x' }] }), []);
  assert.deepEqual(kinds({ ...base, processes: [base.processes[0], { pid: 2, role: 'backend', envLine: backendEnv.replace('/q/profiles/default/codex-home', '/Users/qauser/.codex') }] }), ['codex-home']);
  // a backend's own home in the profile (an added account's, RM10) is the copy's; one elsewhere, or the backends folder itself, is not
  const inProfile = (home) => kinds({ ...base, expected: { ...EXPECT, backendDirs: ['/q/profiles/default/backends'] }, processes: [base.processes[0], { pid: 2, role: 'host-node', envLine: backendEnv.replace('/q/profiles/default/codex-home', home) }] });
  assert.deepEqual(inProfile('/q/profiles/default/backends/framework/accounts/acct-1/codex-home'), []);
  assert.deepEqual(inProfile('/q/profiles/default/backends'), ['codex-home']);
  assert.deepEqual(inProfile('/q/profiles/default/backendsx/a'), ['codex-home']);
  assert.deepEqual(kinds({ ...base, processes: [{ pid: 1, role: 'app-main', envLine: mainEnv.replace('CODEX_SPARKLE_ENABLED=false', '') }, base.processes[1]] }), ['sparkle']);
  assert.deepEqual(kinds({ ...base, processes: [base.processes[0]] }), ['codex-home-unobserved']);
  assert.deepEqual(evaluateIsolation({ expected: EXPECT, ...base, processes: [base.processes[0]], requireCodexHomeObserved: false, requireUserDataObserved: false }).violations, []);
});

test('readiness: needs our Host, an app session with a ready primary, and a fresh boot marker', () => {
  const t0 = Date.parse('2026-10-11T12:00:00Z');
  const diag = (state, pid = 42) => ({ host: { pid }, mux: { backends: [{ key: 'primary', owner: 'app', state }, { key: 'mod:x/b', owner: 'mod:x', state: 'ready' }] } });
  const boot = { generation: 3, startedAt: '2026-10-11T12:00:05Z', state: 'booting' };
  const ours = new Set([42]);
  assert.equal(evaluateReadiness({ diagnostics: diag('ready'), boot, hostPids: ours, launchedAtMs: t0 }).ready, true);
  assert.deepEqual(evaluateReadiness({ diagnostics: null, boot: null, hostPids: ours, launchedAtMs: t0 }).missing, ['hostAnswers', 'hostIsOurs', 'appSessionReady', 'bootMarker']);
  assert.deepEqual(evaluateReadiness({ diagnostics: diag('starting'), boot, hostPids: ours, launchedAtMs: t0 }).missing, ['appSessionReady']);
  assert.deepEqual(evaluateReadiness({ diagnostics: diag('ready', 7), boot, hostPids: ours, launchedAtMs: t0 }).missing, ['hostIsOurs'], 'stale Host from an earlier run');
  assert.deepEqual(evaluateReadiness({ diagnostics: diag('ready'), boot: { ...boot, startedAt: '2026-10-11T11:00:00Z' }, hostPids: ours, launchedAtMs: t0 }).missing, ['bootMarker'], 'stale boot marker');
  const onlyModBackend = { host: { pid: 42 }, mux: { backends: [{ key: 'primary', owner: 'app', state: 'stopped' }] } };
  assert.equal(evaluateReadiness({ diagnostics: onlyModBackend, boot, hostPids: ours, launchedAtMs: t0 }).checks.appSessionReady, false);
});

test('signalTargets: never signals a group that contains the harness or its shell', () => {
  const rows = parsePs(`
  10     1  10 zsh -c node qa.mjs stop --root /r
  11    10  10 node /w/scripts/qa.mjs stop --root /r
  20     1  20 /r/apps/b/ChatGPT Mods QA.app/Contents/MacOS/ChatGPT
  21    20  20 /r/apps/b/H
  30    10  10 /r/apps/b/stray-child-in-the-shell-group
  40     1  40 /r/apps/b/other-leader
`);
  const exclude = selfAndAncestors(rows, 11);
  const owned = ownedProcesses(rows, ['/r'], exclude);
  const t = signalTargets(rows, owned, exclude);
  assert.deepEqual(t.pids.sort((a, b) => a - b), [20, 21, 30, 40]);
  assert.deepEqual(t.groups.sort((a, b) => a - b), [20, 40], 'group 10 holds the harness shell and is never signalled as a group');
});

const HOME = '/Users/qauser';
const UD = '/q/profiles/default/userData';
const E2 = { codexHomes: ['/q/profiles/default/codex-home'], userDataDirs: [UD], home: HOME };
const P2 = [{ pid: 1, role: 'app-main', envLine: mainEnv }, { pid: 2, role: 'backend', envLine: backendEnv }, { pid: 3, role: 'chromium-renderer', envLine: backendEnv }];
const GOOD_FILES = [{ pid: 1, name: `${UD}/Local State` }, { pid: 3, name: `${UD}/Cookies` }];
const kinds2 = (o) => evaluateIsolation({ expected: E2, processes: P2, files: GOOD_FILES, ...o }).violations.map((v) => v.kind);

test('isolation R1c: a failed or empty ps/lsof inspection is a violation, never a pass', () => {
  assert.deepEqual(kinds2({}), []);
  assert.deepEqual(kinds2({ inspectFailures: [{ command: 'lsof', detail: 'empty output' }] }), ['inspect-failed']);
  assert.deepEqual(kinds2({ inspectFailures: [{ pid: 2, command: 'ps eww', detail: 'exit 1' }] }), ['inspect-failed']);
  const v = evaluateIsolation({ expected: E2, processes: P2, files: GOOD_FILES, inspectFailures: [{ pid: 2, command: 'ps eww', detail: 'exit 1' }] });
  assert.equal(v.ok, false);
});

test('isolation R1c: positive evidence of the profile userData by the main or a renderer process is required', () => {
  assert.deepEqual(kinds2({ files: [] }), ['user-data-unobserved']);
  assert.deepEqual(kinds2({ files: [{ pid: 2, name: `${UD}/x` }] }), ['user-data-unobserved'], 'a backend holding it does not count');
  assert.deepEqual(kinds2({ files: [{ pid: 1, name: `${UD}/x` }] }), []);
  assert.deepEqual(kinds2({ files: [{ pid: 3, name: `${UD}/x` }] }), []);
  assert.deepEqual(kinds2({ files: [], requireUserDataObserved: false }), [], 'the early check does not require it');
  assert.deepEqual(kinds2({ files: [{ pid: 1, name: '/q/profiles/default/userData-other/x' }] }), ['user-data-unobserved'], 'a sibling dir is not the profile');
});

test('isolation R1c: stock userData dirs, Group Containers and ~/.codex are all rejected', () => {
  const bad = (name) => kinds2({ files: [...GOOD_FILES, { pid: 1, name }] });
  for (const n of ['ChatGPT', 'Codex', 'ChatGPT Mods']) {
    assert.deepEqual(bad(`${HOME}/Library/Application Support/${n}/Cookies`), ['stock-user-data'], n);
    assert.deepEqual(bad(`${HOME}/Library/Application Support/${n}`), ['stock-user-data'], n);
  }
  assert.deepEqual(bad(`${HOME}/Library/Application Support/ChatGPT Mods Control/x`), [], 'a different directory');
  assert.deepEqual(bad(`${HOME}/Library/Group Containers/2DC432GLL2/x.db`), ['group-container']);
  assert.deepEqual(bad(`${HOME}/.codex/config.toml`), ['home-codex']);
  // when the profile's own userData is one of those names it is the profile, not the stock dir
  const own = `${HOME}/Library/Application Support/ChatGPT Mods`;
  assert.deepEqual(evaluateIsolation({ expected: { ...E2, userDataDirs: [own] }, processes: P2, files: [{ pid: 1, name: `${own}/Local State` }] }).violations, []);
});

test('F4: the launch env carries the Computer Use switch and the isolation check verifies it on the main process', () => {
  assert.ok(LAUNCH_ENV.includes('CODEX_ELECTRON_SKIP_COMPUTER_USE_CANONICAL_REFRESH=1') && LAUNCH_ENV.includes('CODEX_SPARKLE_ENABLED=false'));
  const without = mainEnv.replace('CODEX_ELECTRON_SKIP_COMPUTER_USE_CANONICAL_REFRESH=1', '');
  assert.deepEqual(kinds2({ processes: [{ pid: 1, role: 'app-main', envLine: without }, ...P2.slice(1)] }), ['skip-computer-use']);
  assert.deepEqual(kinds2({ processes: [{ pid: 1, role: 'app-main', envLine: without.replace('TMPDIR', 'CODEX_ELECTRON_SKIP_COMPUTER_USE_CANONICAL_REFRESH=0 TMPDIR') }, ...P2.slice(1)] }), ['skip-computer-use'], 'a value other than 1 fails');
  assert.deepEqual(kinds2({}), []);
});

test('F2: rebuild directory planning is safe', () => {
  const has = (...names) => (n) => names.includes(n);
  const never = () => false;
  assert.deepEqual(planRebuildDir({ base: 'b-h', exists: has(), isProtected: never }), { name: 'b-h', deleteExisting: false });
  assert.deepEqual(planRebuildDir({ base: 'b-h', exists: has('b-h'), isProtected: never }), { name: 'b-h', deleteExisting: true });
  const prot = planRebuildDir({ base: 'b-h', exists: has('b-h'), isProtected: (n) => n === 'b-h' });
  assert.deepEqual([prot.name, prot.deleteExisting], ['b-h-r1', false]);
  assert.equal(planRebuildDir({ base: 'b-h', exists: has('b-h', 'b-h-r1', 'b-h-r2'), isProtected: (n) => n === 'b-h' }).name, 'b-h-r3');
  assert.equal(planRebuildDir({ base: 'b-h', exists: has('b-h', 'b-h-r1'), isProtected: (n) => n === 'b-h' || n === 'b-h-r1' }).deleteExisting, false, 'a protected base is never deleted');
});

test('F2 (contracts v1.6): a copy named only in the profile lkg-app is never deleted; no root-wide apps/lkg is involved', () => {
  const real = (p) => p;
  const prot = protectedAppDirs({ symlinkTarget: '/r/apps/b-new/ChatGPT Mods.app', lkgAppText: '/r/apps/b-h/ChatGPT Mods.app\n', realpath: real });
  assert.deepEqual([...prot].sort(), ['/r/apps/b-h', '/r/apps/b-new']);
  // the matching base copy is only the LKG: it must be kept, the rebuild goes to -r1
  const plan = planRebuildDir({ base: 'b-h', exists: (n) => n === 'b-h', isProtected: (n) => prot.has(`/r/apps/${n}`) });
  assert.deepEqual([plan.name, plan.deleteExisting], ['b-h-r1', false]);
  // not named anywhere: deletable
  const other = protectedAppDirs({ symlinkTarget: '/r/apps/x/A.app', lkgAppText: null, realpath: real });
  assert.equal(planRebuildDir({ base: 'b-h', exists: (n) => n === 'b-h', isProtected: (n) => other.has(`/r/apps/${n}`) }).deleteExisting, true);
  assert.deepEqual([...protectedAppDirs({ symlinkTarget: null, lkgAppText: '   ', realpath: real })], []);
  // symlinks in the path are resolved before comparing
  assert.deepEqual([...protectedAppDirs({ symlinkTarget: '/alias/apps/b/A.app', lkgAppText: null, realpath: (p) => p.replace('/alias', '/real') })], ['/real/apps/b']);
});

test('prune: the previous target a rebuild recorded and every boot record\'s copy are protected too', () => {
  const prot = protectedAppDirs({ symlinkTarget: '/r/apps/b-t/A.app', lkgAppText: null, previousAppText: '/r/apps/b-p/A.app\n',
    generationApps: ['/r/apps/b-g/A.app', '/r/apps/b-t/A.app'] });
  assert.deepEqual([...prot].sort(), ['/r/apps/b-g', '/r/apps/b-p', '/r/apps/b-t']);
  // a rebuild never deletes the previous target to rebuild in its place
  assert.equal(planRebuildDir({ base: 'b-p', exists: (n) => n === 'b-p', isProtected: (n) => prot.has(`/r/apps/${n}`) }).name, 'b-p-r1');
});

test('prune: superseded copies are this build\'s unprotected, unused and finished ones; another build\'s only once stale', () => {
  const names = ['b-t', 'b-p', 'b-old', 'b-new', 'b-run', 'b-building', 'b-r1', 'other-x', 'other-old', 'other-lkg', 'control', 'b'];
  const got = supersededCopies({ build: 'b', names, isProtected: (n) => n === 'b-t' || n === 'b-p' || n === 'other-lkg', inUse: (n) => n === 'b-run', unfinished: (n) => n === 'b-building',
    stale: (n) => n === 'other-old' || n === 'other-lkg' });
  assert.deepEqual(got, ['b-new', 'b-old', 'b-r1', 'other-old'], 'another build\'s stale copy goes; a protected one stays');
  assert.deepEqual(supersededCopies({ build: 'b', names: [], isProtected: () => false }), []);
  assert.deepEqual(supersededCopies({ build: 'b', names: ['b-x'], isProtected: () => false }), ['b-x'], 'the optional checks default to keep nothing back');
});

test('the superseded framework versions: all but those a pointer or a boot record names and the newest installed', () => {
  const names = ['current', 'previous', 'lkg', '.install-x.tmp', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6'];
  const mtime = (n) => Number(n.slice(1));
  assert.deepEqual(supersededFrameworks({ names, kept: new Set(['v1', 'v2']), mtime }), ['v3']);
  assert.deepEqual(supersededFrameworks({ names, kept: new Set(), mtime, newest: 1 }), ['v1', 'v2', 'v3', 'v4', 'v5']);
});

test('prune: a QA root keeps the launch target, the previous target, the LKG, boot records\' copies and other builds\' recent ones', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-prune-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const P = qaPaths(root);
  const app = (n) => path.join(P.layout.apps, n, 'ChatGPT Mods.app');
  const copy = (n, { report = true, ageMs = 0 } = {}) => {
    fs.mkdirSync(app(n), { recursive: true });
    if (report) fs.writeFileSync(path.join(P.layout.apps, n, 'build-report.json'), '{}');
    if (ageMs) { const t0 = new Date(Date.now() - ageMs); fs.utimesSync(path.join(P.layout.apps, n), t0, t0); }
  };
  for (const n of ['B-target', 'B-prev', 'B-lkg', 'B-gen', 'B-old', 'B-unselected', 'OTHER-x', 'control']) copy(n);
  copy('B-building', { report: false });
  copy('B-failed', { report: false, ageMs: 2 * 60 * 60_000 });
  copy('OTHER-old', { ageMs: 3 * 24 * 60 * 60_000 });   // another build's, untouched for days: it goes
  fs.symlinkSync(app('B-target'), P.appPath);
  fs.mkdirSync(path.dirname(P.layout.lkgApp), { recursive: true }); fs.writeFileSync(P.layout.lkgApp, `${app('B-lkg')}\n`);
  fs.mkdirSync(P.qaDir, { recursive: true }); fs.writeFileSync(P.previousApp, `${app('B-prev')}\n`);
  fs.mkdirSync(P.layout.generations, { recursive: true }); fs.writeFileSync(path.join(P.layout.generations, '7.json'), JSON.stringify({ n: 7, appCandidate: app('B-gen') }));
  fs.writeFileSync(path.join(P.layout.generations, 'lkg'), '7');
  assert.deepEqual(await pruneSupersededCopies(root, 'B'), ['B-failed', 'B-old', 'B-unselected', 'OTHER-old']);
  assert.deepEqual(fs.readdirSync(P.layout.apps).sort(), ['B-building', 'B-gen', 'B-lkg', 'B-prev', 'B-target', 'OTHER-x', 'control']);
  assert.deepEqual(await pruneSupersededCopies(root, 'B'), [], 'a second prune removes nothing');
});

test('keychain: QA launches with --use-mock-keychain (once) and the isolation check verifies the main process has it', () => {
  assert.deepEqual(buildOpenArgs('/a.app', ['--use-mock-keychain']).filter((x) => x === '--use-mock-keychain').length, 1);
  assert.deepEqual(kinds2({ processes: [{ pid: 1, role: 'app-main', envLine: mainEnv.replace(' --use-mock-keychain', '') }, ...P2.slice(1)] }), ['mock-keychain']);
  assert.deepEqual(kinds2({ requireMockKeychain: false, processes: [{ pid: 1, role: 'app-main', envLine: mainEnv.replace(' --use-mock-keychain', '') }, ...P2.slice(1)] }), []);
  assert.deepEqual(kinds2({}), []);
});

// ---- keychain prompt safety net
const ACL = '<AclValidationContext(action:24)SUBJECT[<ThresholdAclSubject(1 of 2)[<CodeSignatureAclSubject[requirement:cdhash H"6233"]>][<KeychainPromptAclSubject(flags: 0x0, desc:Codex Storage Key)>]>]OBJECT[...<…>';
const LOG = [
  'Timestamp               Ty Process[PID:TID]',
  `2026-10-11 16:42:15.752 Df securityd[157:1cd1cb7] [com.apple.securityd:kcacl] displaying keychain prompt for /Users/qauser/cmq/apps/26.1007-abc/ChatGPT Mods.app(28275); ACL: ${ACL}`,
  `2026-10-11 16:42:16.001 Df securityd[157:1cd1cb8] [com.apple.securityd:kcacl] displaying keychain prompt for /Applications/Other (beta).app(555); ACL: ${ACL.replace('Codex Storage Key', 'Other Item')}`,
  `2026-10-11 16:42:17.250 Df securityd[157:1cd1cb9] [com.apple.securityd:kcacl] displaying keychain prompt for /private/var/x/cmq/apps/b/ChatGPT Mods.app(900); ACL: <x>`,
  '2026-10-11 16:42:18.000 Df securityd[157:1] some other securityd line mentioning displaying keychain prompt but not for a path',
  'garbage',
].join('\n');

test('keychain prompts: log lines are parsed (paths with parentheses, item names, local time)', () => {
  const e = parsePromptLog(LOG);
  assert.deepEqual(e.map((x) => [x.pid, x.path, x.item]), [
    [28275, '/Users/qauser/cmq/apps/26.1007-abc/ChatGPT Mods.app', 'Codex Storage Key'],
    [555, '/Applications/Other (beta).app', 'Other Item'],
    [900, '/private/var/x/cmq/apps/b/ChatGPT Mods.app', null],
  ]);
  assert.equal(e[0].ts, '2026-10-11 16:42:15.752');
  assert.equal(new Date(e[0].atMs).getMilliseconds(), 752);
  assert.deepEqual(parsePromptLog(''), []);
});

test('keychain prompts: only prompts for this run (pid in the app group, or path under the QA root) and after the start count', () => {
  const e = parsePromptLog(LOG);
  const run = (o) => matchPrompts(e, o).map((x) => x.pid);
  assert.deepEqual(run({ pids: new Set([28275]), roots: [] }), [28275]);
  assert.deepEqual(run({ pids: new Set(), roots: ['/Users/qauser/cmq'] }), [28275]);
  assert.deepEqual(run({ pids: new Set(), roots: ['/Users/qauser/cmq', '/private/var/x/cmq'] }), [28275, 900]);
  assert.deepEqual(run({ pids: new Set([555]), roots: ['/Users/qauser/cmq'] }), [28275, 555]);
  assert.deepEqual(run({ pids: new Set(), roots: ['/Users/qauser/cmq2'] }), [], 'a sibling directory is not the root');
  assert.deepEqual(run({ pids: new Set([28275]), roots: [], sinceMs: parseLogTime('2026-10-11 16:42:16.000') }), [], 'older than the launch');
  assert.deepEqual(run({ pids: new Set(), roots: [] }), []);
});

test('keychain prompts: log show arguments use local time and the securityd predicate; exit code and error name are fixed', () => {
  const ms = parseLogTime('2026-10-11 16:42:15.000');
  assert.equal(logTime(ms), '2026-10-11 16:42:15');
  assert.deepEqual(logShowArgs(ms), ['show', '--start', '2026-10-11 16:42:15', '--style', 'compact', '--predicate', PROMPT_PREDICATE]);
  assert.match(PROMPT_PREDICATE, /process == "securityd"/);
  assert.match(PROMPT_PREDICATE, /CONTAINS "displaying keychain prompt"/);
  assert.equal(ERROR_PROMPT, 'keychain-prompt-detected');
  assert.notEqual(EXIT_PROMPT, 0);
});

test('keychain prompts: SecurityAgent selection, TERM first, KILL only if it ignores TERM', async () => {
  const rows = parsePs(`
  10 1 10 /System/Library/Frameworks/Security.framework/Versions/A/MacOS/SecurityAgent.app/Contents/MacOS/SecurityAgent
  11 1 11 /Users/qauser/Library/Application Support/Foo/SecurityAgentHelper
  12 1 12 /usr/bin/ssh
`);
  assert.deepEqual(selectSecurityAgents(rows).map((r) => r.pid), [10]);
  const mk = (ignoresTerm) => {
    const alive = new Set([10]); const sent = [];
    return { sent, deps: {
      ps: () => rows.filter((r) => r.pid !== 10 || alive.has(10)),
      kill: (pid, sig) => { sent.push(`${sig}:${pid}`); if (sig === 'SIGKILL' || (sig === 'SIGTERM' && !ignoresTerm)) alive.delete(pid); return true; },
      sleep: async () => {},
    } };
  };
  const polite = mk(false);
  const r1 = await dismissSecurityAgents(polite.deps);
  assert.deepEqual(polite.sent, ['SIGTERM:10']);
  assert.deepEqual([r1.found, r1.termed, r1.killed, r1.remaining], [[10], [10], [], []]);
  const stubborn = mk(true);
  const r2 = await dismissSecurityAgents(stubborn.deps, { graceMs: 400, stepMs: 200 });
  assert.deepEqual(stubborn.sent, ['SIGTERM:10', 'SIGKILL:10']);
  assert.deepEqual([r2.termed, r2.killed, r2.remaining], [[10], [10], []]);
  const none = mk(false); none.deps.ps = () => [];
  assert.deepEqual((await dismissSecurityAgents(none.deps)).found, []);
});

test('temp files: a copy\'s asar extractions are Chromium temp names with its bundle id; only those match', () => {
  const names = ['.dev.codexmods.app.Ab3dE9', '.dev.codexmods.app.zz', 'dev.codexmods.app.Ab3dE9', '.com.openai.codex.Ab3dE9', '.dev.codexmods.app.Ab3dE9x', 'TemporaryDirectory.Ab3dE9'];
  assert.deepEqual(copyTempFiles(names, 'dev.codexmods.app'), ['.dev.codexmods.app.Ab3dE9']);
});

test('temp files: any modded copy (main or a framework helper, any root) blocks the cleanup; the stock app does not', () => {
  const copy = '/Users/q/cmq/apps/b-h/ChatGPT Mods.app';
  assert.equal(modCopyRunning([{ command: `${copy}/Contents/MacOS/ChatGPT --user-data-dir=/x` }]), true);
  assert.equal(modCopyRunning([{ command: `${copy}/Contents/Frameworks/Codex Framework.framework/Versions/1/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer) --type=renderer` }]), true);
  assert.equal(modCopyRunning([{ command: '/Users/q/other/ChatGPT Mods Control.app/Contents/MacOS/ChatGPT' }]), true);
  assert.equal(modCopyRunning([{ command: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT' }, { command: '/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/1/Helpers/x' }]), false);
  assert.equal(modCopyRunning([{ command: '/bin/zsh -c ChatGPT' }]), false);
});

test('temp files: the cleanup removes only the copy\'s regular temp files, and nothing while a copy runs', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-temp-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const n of ['.dev.codexmods.app.aaaaaa', '.dev.codexmods.app.bbbbbb', '.com.openai.codex.cccccc', 'keep.txt']) fs.writeFileSync(path.join(dir, n), 'x'.repeat(10));
  fs.mkdirSync(path.join(dir, '.dev.codexmods.app.dddddd'));   // not a regular file: left alone
  const running = [{ command: '/r/apps/b/ChatGPT Mods.app/Contents/MacOS/ChatGPT' }];
  assert.deepEqual(clearCopyTempFiles({ dir, rows: running }), { skipped: 'a modded copy is running' });
  assert.equal(fs.readdirSync(dir).length, 5);
  assert.deepEqual(clearCopyTempFiles({ dir, rows: [] }), { removed: 2, bytes: 20 });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['.com.openai.codex.cccccc', '.dev.codexmods.app.dddddd', 'keep.txt']);
  assert.deepEqual(Object.keys(clearCopyTempFiles({ dir: path.join(dir, 'missing'), rows: [] })), ['error'], 'a failure is reported, never thrown');
});
