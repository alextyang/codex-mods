// D22: session restoration started a QA copy with no isolation arguments. All system IO is fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { qaPreferences, suppressRestoration } from '../restoration.mjs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { qaPaths, buildOpenArgs } from '../args.mjs';
import { sys, stop, status, collectIsolation, launch, setup } from '../commands.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-d22-'));
  const P = qaPaths(root);
  fs.mkdirSync(P.qaDir, { recursive: true });
  const original = { ...sys };
  Object.assign(sys, {
    ps: () => [], psEnv: (pid) => ({ status: 0, stdout: `${pid} ChatGPT` }),
    lsof: () => ({ status: 0, stdout: `p42\nn${P.layout.userData}/Cookies\n` }),
    logShow: () => ({ status: 0, stdout: '' }),
    run: () => { throw new Error('unexpected system command'); },
    preferences: { read: () => undefined, write: () => {} },
  });
  t.after(() => { Object.assign(sys, original); delete sys.preferences; fs.rmSync(root, { recursive: true, force: true }); });
  return { root, P };
}

test('D22: every launch suppresses state restoration, including diagnostic modes', () => {
  for (const mode of [{}, { noenv: true }, { cuRefresh: true }]) {
    const args = buildOpenArgs('/q/ChatGPT Mods QA.app', ['--user-data-dir=/q/ud'], mode);
    assert.ok(args.includes('-F'));
    assert.deepEqual(args.slice(-6), ['-ApplePersistenceIgnoreState', 'YES', '-NSDisablePersistence', 'YES', '-NSQuitAlwaysKeepsWindows', 'NO']);
    assert.ok(args.includes('--use-mock-keychain'));
  }
});

test('D22: stop cleans both loginwindow domains even with no process; unrelated apps survive unchanged', async (t) => {
  const { root } = fixture(t);
  const qa = { BundleID: 'dev.codexmods.app', Path: `${root}/apps/old/ChatGPT Mods.app`, BackgroundState: 2 };
  const daily = { BundleID: 'dev.codexmods.app', Path: '/Users/qa/Applications/Daily.app' };
  const stock = { BundleID: 'com.openai.chat', Path: '/Applications/ChatGPT.app' };
  const prefs = new Map([[false, { TALAppsToRelaunchAtLogin: [qa, daily, stock], Other: 7 }], [true, { TALAppsToRelaunchAtLogin: [stock, qa], Other: 8 }]]);
  const writes = [];
  sys.preferences = {
    read: (_domain, currentHost, key) => structuredClone(prefs.get(!!currentHost)?.[key]),
    write: (domain, key, value, currentHost) => { writes.push({ domain, key, value, currentHost }); if (domain === 'com.apple.loginwindow') prefs.get(!!currentHost)[key] = value; },
  };
  const r = await stop({ root });
  assert.equal(r.code, 0);
  assert.deepEqual(prefs.get(false), { TALAppsToRelaunchAtLogin: [daily, stock], Other: 7 });
  assert.deepEqual(prefs.get(true), { TALAppsToRelaunchAtLogin: [stock], Other: 8 });
  assert.ok(writes.some((w) => w.domain === 'dev.codexmods.app' && w.key === 'NSQuitAlwaysKeepsWindows' && w.value === false));
  assert.ok(writes.some((w) => w.domain === 'dev.codexmods.app' && w.key === 'NSDisablePersistence' && w.value === true));
  assert.ok(writes.some((w) => w.domain === 'dev.codexmods.app' && w.key === 'NSDisablePersistence' && w.value === true && w.currentHost === true), 'host-specific defaults cannot override the suppression');
  assert.equal((await stop({ root })).code, 0, 'cleanup is idempotent');
});

test('D22: cleanup failure makes stop fail instead of reporting successful isolation', async (t) => {
  const { root } = fixture(t);
  sys.preferences.read = () => { throw new Error('permission denied'); };
  const r = await stop({ root });
  assert.equal(r.code, 1);
  assert.match(r.result.restoration.error, /permission denied/);
});

test('D22: status detects a restored main even without a Host or Keychain prompt', async (t) => {
  const { root } = fixture(t);
  const command = `${root}/apps/old/ChatGPT Mods.app/Contents/MacOS/ChatGPT`;
  sys.ps = () => [{ pid: 42, ppid: 1, pgid: 42, command }];
  const r = await status({ root });
  assert.equal(r.code, 3);
  assert.equal(r.result.error, 'outside-harness');
  assert.deepEqual(r.result.unmanaged.map((p) => p.pid), [42]);
  assert.match(r.result.instruction, /stop.*launch/);
});

test('D22: isolation refuses an outside-harness main, even with otherwise valid isolation flags', (t) => {
  const { root, P } = fixture(t);
  const command = `${root}/apps/old/ChatGPT Mods.app/Contents/MacOS/ChatGPT --user-data-dir=${P.layout.userData} --use-mock-keychain`;
  const rows = [{ pid: 42, ppid: 1, pgid: 42, command }];
  sys.ps = () => rows;
  sys.psEnv = () => ({ status: 0, stdout: `42 ${command} CODEX_SPARKLE_ENABLED=false CODEX_ELECTRON_SKIP_COMPUTER_USE_CANONICAL_REFRESH=1 CODEX_HOME=${P.layout.codexHome}` });
  const r = collectIsolation(root, rows, 42, {});
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.kind === 'outside-harness' && v.pid === 42));
});

test('D22: a matching harness receipt and launch environment pass; pid reuse or a second restored copy fail', (t) => {
  const { root, P } = fixture(t);
  const command = `${root}/apps/build/ChatGPT Mods.app/Contents/MacOS/ChatGPT --user-data-dir=${P.layout.userData} --use-mock-keychain`;
  const rows = [{ pid: 42, ppid: 1, pgid: 42, command }];
  sys.ps = () => rows;
  sys.psEnv = (pid) => ({ status: 0, stdout: `${pid} ${command} CODEXMODS_QA_LAUNCH_ID=run-1 CODEX_SPARKLE_ENABLED=false CODEX_ELECTRON_SKIP_COMPUTER_USE_CANONICAL_REFRESH=1 CODEX_HOME=${P.layout.codexHome}` });
  const receipt = path.join(P.qaDir, 'harness-launch.json');
  fs.writeFileSync(receipt, JSON.stringify({ launchId: 'run-1', pid: 42 }));
  assert.equal(collectIsolation(root, rows, 42, {}).ok, true);
  fs.writeFileSync(receipt, JSON.stringify({ launchId: 'old-run', pid: 42 }));
  assert.ok(collectIsolation(root, rows, 42, {}).violations.some((v) => v.kind === 'outside-harness'));
  fs.writeFileSync(receipt, JSON.stringify({ launchId: 'run-1', pid: 43 }));
  assert.ok(collectIsolation(root, rows, 42, {}).violations.some((v) => v.kind === 'outside-harness'));
  fs.writeFileSync(receipt, JSON.stringify({ launchId: 'run-1', pid: 42 }));
  rows.push({ pid: 43, ppid: 1, pgid: 43, command });
  assert.deepEqual(collectIsolation(root, rows, 42, {}).violations.filter((v) => v.kind === 'outside-harness').map((v) => v.pid), [43]);
});

test('D22: stop cleans Resume state after quit, when loginwindow may have added an entry', async (t) => {
  const { root, P } = fixture(t);
  const command = `${root}/apps/build/ChatGPT Mods.app/Contents/MacOS/ChatGPT`;
  let rows = [{ pid: 42, ppid: 1, pgid: 42, command }];
  let entries = [];
  sys.ps = () => rows;
  sys.run = () => { entries.push({ Path: `${root}/apps/build/ChatGPT Mods.app` }); rows = []; return { status: 0 }; };
  sys.preferences = {
    read: (_domain, _host, key) => (key === 'TALAppsToRelaunchAtLogin' ? entries : undefined),
    write: (domain, key, value) => { if (domain === 'com.apple.loginwindow' && key === 'TALAppsToRelaunchAtLogin') entries = value; },
  };
  const receipt = path.join(P.qaDir, 'harness-launch.json');
  fs.writeFileSync(receipt, '{"launchId":"run-1","pid":42}');
  assert.equal((await stop({ root })).code, 0);
  assert.deepEqual(entries, []);
  assert.equal(fs.existsSync(receipt), false);
});

test('D22: defaults adapter preserves typed preference values and scopes; refuses non-QA users before any command', () => {
  // Fake defaults stores full plist domains; real plutil exercises the wire format, with no preference writes.
  const domains = new Map();
  const convert = (format, input) => {
    const r = spawnSync('/usr/bin/plutil', ['-convert', format, '-o', '-', '-'], { input, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return r.stdout;
  };
  const keyOf = (domain, host) => `${host ? 'host' : 'user'}:${domain}`;
  const run = (cmd, args, opts) => {
    if (cmd === '/usr/bin/plutil') return spawnSync(cmd, args, { ...opts, encoding: 'utf8' });
    assert.equal(cmd, '/usr/bin/defaults');
    const host = args[0] === '-currentHost';
    const [verb, domain, key, xml] = args.slice(host ? 1 : 0);
    const id = keyOf(domain, host);
    if (verb === 'export') return { status: 0, stdout: convert('xml1', JSON.stringify(domains.get(id) ?? {})) };
    assert.equal(verb, 'write');
    domains.set(id, { ...domains.get(id), [key]: xml === '-bool' ? args.at(-1) === 'true' : JSON.parse(convert('json', xml)) });
    return { status: 0, stdout: '' };
  };
  const prefs = qaPreferences(run, () => 503);
  const entry = { Path: '/qa/Copy.app', BundleID: 'dev.codexmods.app', BackgroundState: 2, Hidden: true };
  domains.set(keyOf('com.apple.loginwindow', true), { Other: 'preserved' });
  prefs.write('com.apple.loginwindow', 'TALAppsToRelaunchAtLogin', [entry], true);
  prefs.write('dev.codexmods.app', 'NSDisablePersistence', true, false);
  assert.deepEqual(prefs.read('com.apple.loginwindow', true, 'TALAppsToRelaunchAtLogin'), [entry]);
  assert.equal(prefs.read('com.apple.loginwindow', true, 'Other'), 'preserved', 'other keys are preserved');
  assert.equal(prefs.read('dev.codexmods.app', false, 'NSDisablePersistence'), true);
  assert.equal(prefs.read('dev.codexmods.app', false, 'Absent'), undefined);
  // A domain that also holds a date (JSON cannot represent it) still yields the key that is read.
  const exported = run;
  const withDate = qaPreferences((cmd, args, opts) => {
    if (cmd === '/usr/bin/defaults' && args.includes('export')) return { status: 0, stdout: convert('xml1', JSON.stringify({ TALAppsToRelaunchAtLogin: [entry] })).replace('<dict>', '<dict><key>When</key><date>2026-10-20T00:00:00Z</date>') };
    return exported(cmd, args, opts);
  }, () => 503);
  assert.deepEqual(withDate.read('com.apple.loginwindow', false, 'TALAppsToRelaunchAtLogin'), [entry]);
  assert.equal(domains.has(keyOf('com.apple.loginwindow', false)), false);
  assert.throws(() => qaPreferences(() => assert.fail('must not run'), () => 501).read('com.apple.loginwindow'), /only.*QA UID503/);
});

test('D22: launch records the main pid and an unpredictable marker supplied to open; isolation accepts that process', async (t) => {
  const { root, P } = fixture(t);
  fs.mkdirSync(P.appPath, { recursive: true });
  fs.mkdirSync(path.dirname(P.layout.profileConfig), { recursive: true });
  fs.writeFileSync(P.layout.profileConfig, JSON.stringify({ launchArgs: [`--user-data-dir=${P.layout.userData}`] }));
  let rows = []; let env = '';
  sys.ps = () => rows;
  sys.psEnv = () => ({ status: 0, stdout: env });
  sys.run = (cmd, args) => {
    assert.equal(cmd, '/usr/bin/open');
    const vars = args.filter((_a, i) => args[i - 1] === '--env');
    const command = `${P.appPath}/Contents/MacOS/ChatGPT ${args.slice(args.indexOf('--args') + 1).join(' ')}`;
    rows = [{ pid: 42, ppid: 1, pgid: 42, command }];
    env = `42 ${command} ${vars.join(' ')}`;
    return { status: 0, stderr: '' };
  };
  const r = await launch({ root, keep: true, fast: true, readyTimeoutMs: 0 });
  assert.equal(r.result.isolationEarly.ok, true);
  assert.equal(r.result.isolation.ok, true);
  const receipt = JSON.parse(fs.readFileSync(path.join(P.qaDir, 'harness-launch.json')));
  assert.equal(receipt.pid, 42);
  assert.match(receipt.launchId, /^[a-f0-9-]{36}$/);
  assert.match(env, new RegExp(`CODEXMODS_QA_LAUNCH_ID=${receipt.launchId}`));
  assert.equal(r.code, 1, 'the fixture deliberately supplies no ready Host');
});

test('D22: setup requests the QA-only builder policy and applies the QA-user preferences', async (t) => {
  const { root, P } = fixture(t);
  const app = path.join(root, 'apps', 'build', 'ChatGPT Mods.app');
  fs.mkdirSync(app, { recursive: true });
  fs.symlinkSync(app, P.appPath);
  fs.mkdirSync(path.dirname(P.layout.profileConfig), { recursive: true });
  fs.writeFileSync(P.layout.profileConfig, JSON.stringify({ signingIdentity: '-', codexHome: P.layout.codexHome, launchArgs: [`--user-data-dir=${P.layout.userData}`], guardStockApp: false }));
  fs.writeFileSync(path.join(path.dirname(app), 'build-report.json'), '{"infoPlist":{"qaNoRestore":true},"qaSocketDirs":{"applied":true}}');
  const writes = [];
  sys.preferences.write = (domain, key, value) => writes.push([domain, key, value]);
  sys.run = (cmd, args) => {
    assert.equal(cmd, process.execPath);
    assert.ok(args.includes('--qa-no-restore'));
    assert.ok(args.includes('--qa-socket-dirs'));
    return { status: 0, stdout: '{}', stderr: '' };
  };
  const r = await setup({ root });
  assert.equal(r.code, 0);
  assert.equal(r.result.restoration.ok, true);
  assert.ok(writes.some(([domain, key, value]) => domain === 'dev.codexmods.app' && key === 'NSDisablePersistence' && value === true));
});

test('D22: relaunch cleanup accepts file URLs and canonical root aliases without matching a neighbouring root or a bundle id alone', async (t) => {
  const { root } = fixture(t);
  let entries = [
    { Path: new URL(`file://${root}/apps/old/ChatGPT%20Mods.app`).href },
    { Path: `${root}-other/apps/ChatGPT Mods.app` },
    { BundleID: 'dev.codexmods.app' },
  ];
  sys.preferences = {
    read: (_domain, _host, key) => (key === 'TALAppsToRelaunchAtLogin' ? entries : undefined),
    write: (domain, key, value) => { if (domain === 'com.apple.loginwindow' && key === 'TALAppsToRelaunchAtLogin') entries = value; },
  };
  const kept = entries.slice(1);
  const alias = `${root}-alias`;
  fs.symlinkSync(root, alias);
  t.after(() => fs.unlinkSync(alias));
  assert.equal((await stop({ root: alias })).code, 0);
  assert.deepEqual(entries, kept);
});

test('D22: absent preference domains are harmless, read errors and failed read-back are reported', () => {
  const missing = qaPreferences(() => ({ status: 1, stderr: 'Domain com.apple.loginwindow does not exist' }), () => 503);
  assert.equal(missing.read('com.apple.loginwindow', true, 'TALAppsToRelaunchAtLogin'), undefined);
  const denied = qaPreferences(() => ({ status: 1, stderr: 'Could not export domain: permission denied' }), () => 503);
  assert.throws(() => denied.read('com.apple.loginwindow', true, 'TALAppsToRelaunchAtLogin'), /permission denied/);
  const r = qaPreferences((cmd, args) => {
    if (cmd === '/usr/bin/plutil') return { status: 0, stdout: args.includes('-extract') ? '<plist version="1.0"><false/></plist>' : '[false]' };
    if (args.includes('write')) return { status: 0, stdout: '' };
    return { status: 0, stdout: '<plist><dict/></plist>' };
  }, () => 503);
  assert.throws(() => r.write('dev.codexmods.app', 'NSDisablePersistence', true, false), /read-back failed/);
});

test('D22: relaunch paths resolve existing ancestors and symlinks before checking whole root components', (t) => {
  const { root } = fixture(t);
  const qa = path.join(root, 'harness');
  const other = path.join(root, 'harness-other');
  fs.mkdirSync(qa);
  fs.mkdirSync(other);
  const alias = path.join(root, 'alias');
  fs.symlinkSync(qa, alias);
  fs.symlinkSync(other, path.join(qa, 'escape'));
  fs.symlinkSync(qa, path.join(other, 'into-qa'));
  let entries = [
    { Path: pathToFileURL(path.join(alias, 'missing', 'Copy #1.app')).href },
    { Path: path.join(other, 'into-qa', 'missing', 'Copy.app') },
    { Path: pathToFileURL(path.join(other, 'Copy.app')).href },
    { Path: path.join(qa, 'escape', 'Copy.app') },
    { Path: path.join(qa, '..', 'harness-other', 'Copy.app') },
    { Path: 'file:///bad%ZZ.app' },
    { BundleID: 'dev.codexmods.app' },
  ];
  const kept = entries.slice(2);
  const preferences = {
    read: (_domain, _host, key) => (key === 'TALAppsToRelaunchAtLogin' ? entries : undefined),
    write: (domain, key, value) => { if (domain === 'com.apple.loginwindow' && key === 'TALAppsToRelaunchAtLogin') entries = value; },
  };
  const result = suppressRestoration({ roots: [alias], preferences });
  assert.equal(result.ok, true);
  assert.equal(result.removed, 2);
  assert.deepEqual(entries, kept);
});
