import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureTomlBool } from '../toml.mjs';
import { evaluateIsolation, OWN_CONTAINER } from '../isolation.mjs';
import { planLateChecks, LATE_CHECK_OFFSETS_MS } from '../readiness.mjs';
import { parseQaArgs, QaUsageError } from '../args.mjs';
import { ensureQaComputerUseOff } from '../commands.mjs';

const ft = (text) => ensureTomlBool(text, 'features', 'computer_use', false);

test('toml: creates the table, replaces a value, keeps every other key/comment, is idempotent', () => {
  assert.deepEqual(ft(''), { text: '[features]\ncomputer_use = false\n', changed: true });
  assert.deepEqual(ft('model = "o3"\n'), { text: 'model = "o3"\n\n[features]\ncomputer_use = false\n', changed: true });
  const flipped = ft('# keep me\n[features]\nfoo = true\ncomputer_use = true # why\nbar = 1\n\n[other]\nx = 1\n');
  assert.equal(flipped.text, '# keep me\n[features]\nfoo = true\ncomputer_use = false # why\nbar = 1\n\n[other]\nx = 1\n');
  assert.equal(flipped.changed, true);
  const same = ft('[features]\ncomputer_use = false\n');
  assert.deepEqual(same, { text: '[features]\ncomputer_use = false\n', changed: false });
  assert.equal(ft(ft('a = 1\n[features]\nz = 2\n[t]\nk = 1\n').text).changed, false);
});

test('toml: key is added inside an existing [features] table (before the next table), other tables with the same key are untouched', () => {
  const r = ft('[features]\nfoo = true\n\n[mcp]\ncomputer_use = true\n');
  assert.equal(r.text, '[features]\nfoo = true\ncomputer_use = false\n\n[mcp]\ncomputer_use = true\n');
  const r2 = ft('[other]\ncomputer_use = true\n');
  assert.equal(r2.text, '[other]\ncomputer_use = true\n\n[features]\ncomputer_use = false\n');
  const r3 = ft('[[servers]]\nname = "a"\n');
  assert.ok(r3.text.endsWith('[features]\ncomputer_use = false\n') && r3.text.startsWith('[[servers]]'));
});

test('toml: dotted form, CRLF files and "[ features ]"-style headers', () => {
  assert.deepEqual(ft('features.computer_use = true\nmodel = "x"\n'), { text: 'features.computer_use = false\nmodel = "x"\n', changed: true });
  assert.equal(ft('features.computer_use = false\n').changed, false);
  assert.equal(ft('[features]\r\nfoo = 1\r\n').text, '[features]\r\nfoo = 1\r\ncomputer_use = false\r\n');
  assert.equal(ft('[ features ]\nfoo = 1\n').text, '[ features ]\nfoo = 1\ncomputer_use = false\n');
});

test('setup config.toml: only the isolated CODEX_HOME is written; other keys kept; backup once; idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-toml-'));
  try {
    const home = path.join(dir, 'codex-home');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, 'config.toml'), 'model = "o3"\n[features]\ncomputer_use = true\n');
    const r1 = ensureQaComputerUseOff({ codexHome: home, isolatedCodexHome: home });
    assert.equal(r1.changed, true);
    assert.equal(r1.backup, path.join(home, 'config.toml.qa-backup'));
    assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), 'model = "o3"\n[features]\ncomputer_use = false\n');
    assert.equal(fs.readFileSync(r1.backup, 'utf8'), 'model = "o3"\n[features]\ncomputer_use = true\n');
    assert.equal(fs.statSync(path.join(home, 'config.toml')).mode & 0o777, 0o600);
    const r2 = ensureQaComputerUseOff({ codexHome: home, isolatedCodexHome: home });
    assert.deepEqual(r2, { path: path.join(home, 'config.toml'), changed: false });
    // a later external edit that re-enables it is corrected again, and the first backup is NOT overwritten
    fs.writeFileSync(path.join(home, 'config.toml'), '[features]\ncomputer_use = true\nextra = 1\n');
    const r3 = ensureQaComputerUseOff({ codexHome: home, isolatedCodexHome: home });
    assert.equal(r3.changed, true); assert.equal(r3.backup, null);
    assert.equal(fs.readFileSync(path.join(home, 'config.toml.qa-backup'), 'utf8'), 'model = "o3"\n[features]\ncomputer_use = true\n');
    // no pre-existing file: created, no backup
    const fresh = path.join(dir, 'fresh');
    const r4 = ensureQaComputerUseOff({ codexHome: fresh, isolatedCodexHome: fresh });
    assert.deepEqual([r4.changed, r4.backup ?? null], [true, null]);
    assert.equal(fs.readFileSync(path.join(fresh, 'config.toml'), 'utf8'), '[features]\ncomputer_use = false\n');
    // a CODEX_HOME that is not the profile's isolated one (daily profile, ~/.codex) is never touched
    const daily = path.join(dir, '.codex'); fs.mkdirSync(daily);
    assert.ok(ensureQaComputerUseOff({ codexHome: daily, isolatedCodexHome: home }).skipped);
    assert.equal(fs.existsSync(path.join(daily, 'config.toml')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const HOME = '/Users/qauser';
const EXP = { codexHomes: ['/q/ch'], userDataDirs: ['/q/ud'], home: HOME };
const PROCS = [{ pid: 1, role: 'app-main', envLine: 'x --use-mock-keychain CODEX_SPARKLE_ENABLED=false CODEX_ELECTRON_SKIP_COMPUTER_USE_CANONICAL_REFRESH=1 CODEX_HOME=/q/ch' }];
const iso = (files) => evaluateIsolation({ processes: PROCS, files: [{ pid: 1, name: '/q/ud/Cookies' }, ...files], expected: EXP });

test('group containers: only the copy\'s own renamed CUA container is allowed (reported as own-container info); every other 2DC432GLL2.* is a violation', () => {
  const own = `${HOME}/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAServicf`;
  const r = iso([{ pid: 1, name: `${own}/Library/x.db` }, { pid: 1, name: own }]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.info['own-container'].files, 2);
  assert.equal(r.violations.length, 0);
  for (const bad of [`${HOME}/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/x`, // the stock container (note the e)
    `${HOME}/Library/Group Containers/2DC432GLL2.com.openai.codex.notifications/x`,
    `${HOME}/Library/Group Containers/2DC432GLL2.com.openai.shared`,
    `${HOME}/Library/Group Containers/2DC432GLL2/x`,
    `${HOME}/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAServicfX/x`, // not the same component
    `${HOME}/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAServicf.bak/x`]) {
    const v = iso([{ pid: 1, name: bad }]);
    assert.deepEqual(v.violations.map((x) => x.kind), ['group-container'], bad);
  }
  assert.ok(OWN_CONTAINER.test('/a/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAServicf'));
  assert.deepEqual(iso([]).info, {});
  // a violation next to the allowed one is still a violation
  assert.equal(iso([{ pid: 1, name: `${own}/a` }, { pid: 2, name: `${HOME}/Library/Group Containers/2DC432GLL2.com.openai.shared/x` }]).ok, false);
});

test('late isolation re-checks: +20 s and +45 s after readiness, never a negative wait; --fast is a launch-only flag', () => {
  assert.deepEqual(LATE_CHECK_OFFSETS_MS, [20000, 45000]);
  assert.deepEqual(planLateChecks(1000, 1000), [{ offsetMs: 20000, atMs: 21000, waitMs: 20000 }, { offsetMs: 45000, atMs: 46000, waitMs: 45000 }]);
  assert.deepEqual(planLateChecks(1000, 30000).map((s) => s.waitMs), [0, 16000], 'a slow earlier step shortens the later waits');
  assert.deepEqual(planLateChecks(1000, 99999).map((s) => s.waitMs), [0, 0]);
  assert.deepEqual(planLateChecks(0, 0, [5000]).map((s) => s.atMs), [5000]);
  assert.equal(parseQaArgs(['launch', '--fast', '--root', '/r']).fast, true);
  assert.equal(parseQaArgs(['launch', '--root', '/r']).fast, false);
  assert.throws(() => parseQaArgs(['stop', '--fast', '--root', '/r']), QaUsageError);
});
