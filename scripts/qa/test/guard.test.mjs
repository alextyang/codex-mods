import test from 'node:test';
import assert from 'node:assert/strict';
import { isAppServer, codexHomeOf, classifyGuardFixtures, withoutFixtures } from '../guard.mjs';
import { ownedProcesses, parsePs, selfAndAncestors } from '../procs.mjs';

const ROOT = '/Users/qauser/cmq';
const HOME = `${ROOT}/profiles/default/codex-home`;
const CTX = { codexHomes: [HOME], appsDirs: [`${ROOT}/apps`] };

test('app-server detection: codex or codex.real with the app-server token; not other processes mentioning it', () => {
  assert.equal(isAppServer('/opt/bin/codex app-server --listen stdio://'), true);
  assert.equal(isAppServer(`env CODEX_HOME=${HOME} /usr/local/bin/codex -c a=b app-server`), true);
  assert.equal(isAppServer('/x/CodexCLI.app/Contents/MacOS/codex.real -c features.x=true app-server --analytics-default-enabled'), true);
  assert.equal(isAppServer('/bin/sh -c grep app-server log'), false);
  assert.equal(isAppServer('/opt/bin/codex exec hello'), false);
  assert.equal(isAppServer('/usr/bin/node app-server.js'), false);
});

test('CODEX_HOME: from the environment line first, else inline in the command line', () => {
  assert.equal(codexHomeOf('codex app-server', `PID TTY codex app-server CODEX_HOME=${HOME} FOO=1`), HOME);
  assert.equal(codexHomeOf(`env CODEX_HOME=${HOME} codex app-server`, undefined), HOME);
  assert.equal(codexHomeOf('codex app-server', 'PID codex app-server FOO=1'), null);
});

test('--guard: an app-server on the QA codex-home from outside apps/ is the fixture; everything else still blocks', () => {
  const envs = { 10: `x codex app-server CODEX_HOME=${HOME}`, 11: 'x codex app-server CODEX_HOME=/Users/qauser/.codex', 12: `x codex app-server CODEX_HOME=${HOME}`, 13: 'x', 14: `x codex app-server CODEX_HOME=${HOME}` };
  const owned = [
    { pid: 10, command: `/opt/homebrew/bin/codex app-server --listen stdio:// # ${ROOT}` },           // fixture (cmdline mentions the root, home from env)
    { pid: 11, command: `/opt/homebrew/bin/codex app-server --cwd ${ROOT}/work` },                      // other CODEX_HOME: blocks
    { pid: 12, command: `${ROOT}/apps/b-1/ChatGPT Mods.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex.real -c a=b app-server` }, // copy's own leftover: blocks
    { pid: 13, command: `${ROOT}/apps/b-1/ChatGPT Mods.app/Contents/Resources/cua_node/bin/node ${ROOT}/framework/1/host.mjs` }, // host: blocks
    { pid: 14, command: `/usr/local/bin/codex exec ${ROOT}/x` },                                          // not an app-server: blocks
  ];
  const r = classifyGuardFixtures(owned, { ...CTX, envLineOf: (pid) => envs[pid] });
  assert.deepEqual(r.fixtures.map((p) => p.pid), [10]);
  assert.deepEqual(r.others.map((p) => p.pid), [11, 12, 13, 14]);
  // inline CODEX_HOME in the command line works without an environment line
  const inline = classifyGuardFixtures([{ pid: 20, command: `env CODEX_HOME=${HOME} /usr/local/bin/codex app-server` }], CTX);
  assert.deepEqual(inline.fixtures.map((p) => p.pid), [20]);
  // no fixtures at all: everything blocks as before
  assert.deepEqual(classifyGuardFixtures(owned.slice(1), { ...CTX, envLineOf: (pid) => envs[pid] }).fixtures, []);
});

test('fixtures are excluded from the ownership scan only while pid AND command match (pid reuse)', () => {
  const rows = parsePs(`
  100     1 100 /sbin/launchd
  200   100 200 /opt/homebrew/bin/codex app-server # ${ROOT}/w
  300     1 300 ${ROOT}/apps/b/ChatGPT Mods.app/Contents/MacOS/ChatGPT
`);
  const ex = selfAndAncestors(rows, 100);
  const saved = [{ pid: 200, command: `/opt/homebrew/bin/codex app-server # ${ROOT}/w` }];
  assert.deepEqual(ownedProcesses(rows, [ROOT], ex).map((r) => r.pid), [200, 300]);
  assert.deepEqual(withoutFixtures(ownedProcesses(rows, [ROOT], ex), saved).map((r) => r.pid), [300]);
  assert.deepEqual(withoutFixtures(ownedProcesses(rows, [ROOT], ex), [{ pid: 200, command: 'something else now' }]).map((r) => r.pid), [200, 300], 'a reused pid is not excluded');
  assert.deepEqual(withoutFixtures(rows, []), rows);
  assert.deepEqual(withoutFixtures(rows, undefined), rows);
});
