// v1.20: AdapterPack.backend.configOverrides -> `-c key=toml` on the primary backend spawn only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, scriptedSpawn, until } from './helpers.mjs';
import { toToml, tomlString, renderTemplate, configOverrideVars, buildConfigOverrideArgs, withConfigArgs } from '../config-overrides.mjs';

const layout = { computerUse: '/prof/computer-use', profileDir: '/prof' };
const profile = { codexHome: '/prof/codex-home' };
const REAL = '/Applications/ChatGPT Mods.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';

test('R19 toml: every value shape', () => {
  assert.equal(toToml('plain'), '"plain"');
  assert.equal(tomlString('a"b\\c\nd\te\u0001\u007f'), '"a\\"b\\\\c\\nd\\te\\u0001\\u007f"');
  assert.equal(tomlString('héllo ✓'), '"héllo ✓"');
  assert.equal(toToml(7), '7');
  assert.equal(toToml(-1.5), '-1.5');
  assert.equal(toToml(true), 'true');
  assert.equal(toToml(false), 'false');
  assert.equal(toToml(['a', 1, true, ['x']]), '["a", 1, true, ["x"]]');
  assert.equal(toToml([]), '[]');
  assert.equal(toToml({ command: '/bin/x', args: ['a', 'b'], n: 1 }), '{ command = "/bin/x", args = ["a", "b"], n = 1 }');
  assert.equal(toToml({ 'needs quote': 1, 'a.b': { c: false }, 'ok_key-1': 2 }), '{ "needs quote" = 1, "a.b" = { c = false }, ok_key-1 = 2 }');
  assert.equal(toToml({}), '{}');
  assert.throws(() => toToml(NaN), { code: 'Invalid' });
  assert.throws(() => toToml(null), { code: 'Invalid' });
  assert.throws(() => toToml(undefined), { code: 'Invalid' });
});

test('R19 templates: every variable, nested strings, and refusal of unknown variables', () => {
  const vars = configOverrideVars({ realCodexPath: REAL, layout, profile });
  assert.deepEqual(vars, {
    appContents: '/Applications/ChatGPT Mods.app/Contents', resources: '/Applications/ChatGPT Mods.app/Contents/Resources',
    relayPath: '/Applications/ChatGPT Mods.app/Contents/Resources/codexmods-relay', computerUseDir: '/prof/computer-use',
    profileDir: '/prof', codexHome: '/prof/codex-home',
  });
  const viaRunning = configOverrideVars({ runningAppPath: '/Apps/Copy.app', realCodexPath: REAL, layout, profile });
  assert.equal(viaRunning.appContents, '/Apps/Copy.app/Contents');
  assert.equal(renderTemplate('${resources}/x/${codexHome}/${profileDir}-${computerUseDir}-${relayPath}-${appContents}', vars),
    '/Applications/ChatGPT Mods.app/Contents/Resources/x//prof/codex-home//prof-/prof/computer-use-/Applications/ChatGPT Mods.app/Contents/Resources/codexmods-relay-/Applications/ChatGPT Mods.app/Contents');
  assert.throws(() => renderTemplate('${nope}', vars), (e) => e.code === 'Invalid' && /\$\{nope\}/.test(e.message));
  assert.throws(() => renderTemplate('${resources}', {}), { code: 'Invalid' }, 'a variable without its input is unavailable');
  assert.throws(() => toToml({ a: ['${bad}'] }, vars), { code: 'Invalid' }, 'substitution reaches every nested string');
  assert.equal(toToml({ a: ['${profileDir}/x'] }, vars), '{ a = ["/prof/x"] }');
});

test('R19 args: the exact -c arguments for a sample pack, inserted before app-server', () => {
  const vars = configOverrideVars({ realCodexPath: REAL, layout, profile });
  const overrides = {
    notify: ['${relayPath}', 'turn-ended'],
    'mcp_servers.node_repl': { command: '${resources}/node_repl', args: ['--home', '${codexHome}'], enabled: true },
    'mcp_servers.cua_repl': { command: '${computerUseDir}/cua', startup_timeout_sec: 30 },
  };
  const cfg = buildConfigOverrideArgs(overrides, vars);
  assert.deepEqual(cfg, [
    '-c', 'notify=["/Applications/ChatGPT Mods.app/Contents/Resources/codexmods-relay", "turn-ended"]',
    '-c', 'mcp_servers.node_repl={ command = "/Applications/ChatGPT Mods.app/Contents/Resources/node_repl", args = ["--home", "/prof/codex-home"], enabled = true }',
    '-c', 'mcp_servers.cua_repl={ command = "/prof/computer-use/cua", startup_timeout_sec = 30 }',
  ]);
  const argv = ['-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled'];
  assert.deepEqual(withConfigArgs(argv, cfg), ['-c', 'features.code_mode_host=true', ...cfg, 'app-server', '--analytics-default-enabled']);
  assert.deepEqual(withConfigArgs(argv, []), argv);
  assert.deepEqual(withConfigArgs(['x'], ['-c', 'a=1']), ['-c', 'a=1', 'x'], 'no app-server token: at the front');
  assert.throws(() => buildConfigOverrideArgs({ 'a=b': 1 }, vars), { code: 'Invalid' });
});

const sample = () => ({
  overrides: { notify: ['${relayPath}', 'turn-ended'], 'mcp_servers.node_repl': { command: '${resources}/node_repl' } },
  vars: configOverrideVars({ realCodexPath: REAL, layout, profile }),
});

test('R19 mux: the args appear on the session primary spawn only; named backends are untouched; restarts keep them', async () => {
  const { spawn, procs } = scriptedSpawn();
  const h = await harness({
    spawn, tuning: { restartIntervalMs: 50 }, primaryConfig: sample(),
    launchFor: (id, def, session) => ({ command: 'codex', args: id === 'primary' ? [...(session?.argv ?? ['app-server'])] : ['app-server', '--named'], env: {}, codexHome: '/h' }),
  });
  try {
    h.attach();
    h.app.raw(JSON.stringify({ codexmodsRelay: 1, argv: ['-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled'] }) + '\n');
    h.app.send({ id: 'init', method: 'initialize', params: {} });
    await until(() => procs.length === 1);
    const expected = [
      '-c', 'features.code_mode_host=true',
      '-c', 'notify=["/Applications/ChatGPT Mods.app/Contents/Resources/codexmods-relay", "turn-ended"]',
      '-c', 'mcp_servers.node_repl={ command = "/Applications/ChatGPT Mods.app/Contents/Resources/node_repl" }',
      'app-server', '--analytics-default-enabled',
    ];
    assert.deepEqual(procs[0].args, expected);
    const init = await procs[0].waitWritten((m) => m.method === 'initialize');
    procs[0].out({ id: init.id, result: {} });
    await h.app.reply('init');
    // Named backend: untouched.
    await h.define('mod:a', 'x');
    const p = h.mux.client('mod:a').request('thread/list', {}, { backend: 'x' });
    await until(() => procs.length === 2);
    assert.deepEqual(procs[1].args, ['app-server', '--named']);
    const i2 = await procs[1].waitWritten((m) => m.method === 'initialize'); procs[1].out({ id: i2.id, result: {} });
    const l = await procs[1].waitWritten((m) => m.method === 'thread/list'); procs[1].out({ id: l.id, result: {} });
    await p;
    // A restarted primary keeps the overrides.
    procs[0].exit(1);
    await until(() => procs.length === 3, 12000, 'restart');
    assert.deepEqual(procs[2].args, expected);
  } finally { await h.close(); }
});

test('R19 mux: an unknown template variable refuses the primary spawn with a clear error and closes that connection', async () => {
  const { spawn, procs } = scriptedSpawn();
  const h = await harness({ spawn, primaryConfig: { overrides: { k: '${nope}/x' }, vars: sample().vars } });
  try {
    h.attach();
    h.app.send({ id: 1, method: 'initialize', params: {} });
    await until(() => h.app.stream.destroyed, 12000, 'connection closed');
    assert.equal(procs.length, 0, 'nothing was spawned');
    const e = h.entries.find((x) => x.level === 'error' && /primary failed to start/.test(x.msg));
    assert.ok(e && /\$\{nope\}/.test(e.data.message), 'the log names the unknown variable');
  } finally { await h.close(); }
});

test('R19 mux: without primaryConfig the launch args are untouched', async () => {
  const { spawn, procs } = scriptedSpawn();
  const h = await harness({ spawn, launchFor: () => ({ command: 'codex', args: ['app-server', '--x'], env: {}, codexHome: '/h' }) });
  try {
    h.attach(); h.app.send({ method: 'wake/up' });
    await until(() => procs.length === 1);
    assert.deepEqual(procs[0].args, ['app-server', '--x']);
  } finally { await h.close(); }
});
