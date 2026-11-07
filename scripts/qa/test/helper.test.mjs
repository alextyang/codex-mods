import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyHelper, RENAMED_ID, STOCK_ID } from '../helper.mjs';
import { removeTomlKeyLines, tomlStringValue } from '../toml.mjs';
import { cleanStaleComputerUseHelper, ensureQaComputerUseOff } from '../commands.mjs';

const f = (rel, s) => ({ rel, bytes: Buffer.from(s) });
const MACHO = (s) => Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.alloc(8), Buffer.from(s)]);

test('helper classification: renamed id everywhere is fine; the stock id anywhere (or no evidence) is stale', () => {
  assert.equal(RENAMED_ID, `${STOCK_ID.slice(0, -1)}f`);
  assert.equal(classifyHelper([]).state, 'empty');
  assert.equal(classifyHelper([f('Contents/Info.plist', `<string>${RENAMED_ID}</string>`)]).state, 'renamed');
  assert.equal(classifyHelper([f('a/Info.plist', RENAMED_ID), f('a/MacOS/x', `grp 2DC432GLL2.${RENAMED_ID}`)]).state, 'renamed');
  const stale = classifyHelper([f('a/Info.plist', STOCK_ID)]);
  assert.equal(stale.state, 'stale'); assert.deepEqual(stale.stockIn, ['a/Info.plist']);
  assert.equal(classifyHelper([f('a/Info.plist', RENAMED_ID), f('a/MacOS/x', STOCK_ID)]).state, 'stale', 'mixed: one unpatched binary defeats the rename');
  assert.equal(classifyHelper([f('a/Info.plist', 'no ids at all')]).state, 'stale', 'no evidence of the rename: remove (conservative)');
  assert.deepEqual(classifyHelper([f('a', `x${RENAMED_ID}`)]).stockIn, [], 'the renamed id does not contain the stock id');
});

test('toml: SKY_CUA_SERVICE_PATH line removal keeps everything else; value extraction', () => {
  const text = '# c\nmodel = "o3"\n[shell_environment_policy.set]\nSKY_CUA_SERVICE_PATH = "/q/ch/computer-use/X.app"\nOTHER = "1"\n[features]\ncomputer_use = false\n';
  const r = removeTomlKeyLines(text, 'SKY_CUA_SERVICE_PATH');
  assert.equal(r.text, '# c\nmodel = "o3"\n[shell_environment_policy.set]\nOTHER = "1"\n[features]\ncomputer_use = false\n');
  assert.deepEqual(r.removed, ['SKY_CUA_SERVICE_PATH = "/q/ch/computer-use/X.app"']);
  assert.equal(removeTomlKeyLines('a = 1\n', 'SKY_CUA_SERVICE_PATH').removed.length, 0);
  assert.equal(removeTomlKeyLines('"SKY_CUA_SERVICE_PATH" = "x"\r\nb = 1\r\n', 'SKY_CUA_SERVICE_PATH').text, 'b = 1\r\n');
  assert.equal(tomlStringValue(text, 'SKY_CUA_SERVICE_PATH'), '/q/ch/computer-use/X.app');
  assert.equal(tomlStringValue("SKY_CUA_SERVICE_PATH = '/lit/p'\n", 'SKY_CUA_SERVICE_PATH'), '/lit/p');
  assert.equal(tomlStringValue('a = 1\n', 'SKY_CUA_SERVICE_PATH'), null);
});

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-helper-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'cmq'); const home = path.join(root, 'profiles', 'default', 'codex-home');
  fs.mkdirSync(home, { recursive: true });
  const helper = (id) => {
    const app = path.join(home, 'computer-use', 'Codex Computer Use.app', 'Contents');
    fs.mkdirSync(path.join(app, 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(app, 'Info.plist'), `<plist><string>${id}</string></plist>`);
    fs.writeFileSync(path.join(app, 'MacOS', 'helper'), MACHO(`entitlements 2DC432GLL2.${id}`));
    fs.writeFileSync(path.join(app, 'MacOS', 'notes.txt'), 'ignored text mentioning ' + STOCK_ID);
  };
  const cfg = path.join(home, 'config.toml');
  return { dir, root, home, helper, cfg };
}

test('setup cleanup: a helper with the stock id is removed with its SKY_CUA_SERVICE_PATH line; config backed up once; idempotent', (t) => {
  const x = fixture(t);
  x.helper(STOCK_ID);
  fs.writeFileSync(x.cfg, `model = "o3"\nSKY_CUA_SERVICE_PATH = "${x.home}/computer-use/Codex Computer Use.app"\n`);
  const r = cleanStaleComputerUseHelper({ root: x.root, codexHome: x.home });
  assert.equal(r.state, 'stale'); assert.equal(r.removedDir, true);
  assert.equal(fs.existsSync(path.join(x.home, 'computer-use')), false);
  assert.equal(fs.readFileSync(x.cfg, 'utf8'), 'model = "o3"\n');
  assert.equal(r.removedConfigLines.length, 1);
  assert.equal(r.backup, `${x.cfg}.qa-backup`);
  assert.match(fs.readFileSync(r.backup, 'utf8'), /SKY_CUA_SERVICE_PATH/);
  const again = cleanStaleComputerUseHelper({ root: x.root, codexHome: x.home });
  assert.deepEqual([again.state, again.removedDir, again.removedConfigLines, again.backup], ['absent', false, [], null]);
  // a second stale helper later: the first backup is kept
  x.helper(STOCK_ID);
  fs.writeFileSync(x.cfg, `SKY_CUA_SERVICE_PATH = "${x.home}/computer-use/y"\nz = 1\n`);
  const r3 = cleanStaleComputerUseHelper({ root: x.root, codexHome: x.home });
  assert.equal(r3.backup, null);
  assert.match(fs.readFileSync(`${x.cfg}.qa-backup`, 'utf8'), /model = "o3"/);
});

test('setup cleanup: a helper carrying the renamed id is kept, config untouched', (t) => {
  const x = fixture(t);
  x.helper(RENAMED_ID);
  const cfgText = `SKY_CUA_SERVICE_PATH = "${x.home}/computer-use/Codex Computer Use.app"\n`;
  fs.writeFileSync(x.cfg, cfgText);
  const r = cleanStaleComputerUseHelper({ root: x.root, codexHome: x.home });
  assert.deepEqual([r.state, r.removedDir, r.removedConfigLines, r.backup], ['renamed', false, [], null]);
  assert.ok(fs.existsSync(path.join(x.home, 'computer-use')));
  assert.equal(fs.readFileSync(x.cfg, 'utf8'), cfgText);
  assert.equal(fs.existsSync(`${x.cfg}.qa-backup`), false);
});

test('setup cleanup: a dangling SKY_CUA_SERVICE_PATH into the missing helper dir is removed; one pointing elsewhere is kept', (t) => {
  const x = fixture(t);
  fs.writeFileSync(x.cfg, `SKY_CUA_SERVICE_PATH = "${x.home}/computer-use/Gone.app"\nk = 1\n`);
  const r = cleanStaleComputerUseHelper({ root: x.root, codexHome: x.home });
  assert.equal(r.state, 'absent'); assert.equal(r.removedConfigLines.length, 1);
  assert.equal(fs.readFileSync(x.cfg, 'utf8'), 'k = 1\n');
  fs.writeFileSync(x.cfg, 'SKY_CUA_SERVICE_PATH = "/somewhere/else/helper"\n');
  assert.deepEqual(cleanStaleComputerUseHelper({ root: x.root, codexHome: x.home }).removedConfigLines, []);
});

test('setup cleanup: never touches a codexHome outside the QA root; a symlinked computer-use is unlinked, not followed', (t) => {
  const x = fixture(t);
  const outside = path.join(x.dir, 'dot-codex'); fs.mkdirSync(path.join(outside, 'computer-use', 'A.app', 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'computer-use', 'A.app', 'Contents', 'Info.plist'), STOCK_ID);
  fs.writeFileSync(path.join(outside, 'config.toml'), 'SKY_CUA_SERVICE_PATH = "x"\n');
  const r = cleanStaleComputerUseHelper({ root: x.root, codexHome: outside });
  assert.ok(r.skipped);
  assert.ok(fs.existsSync(path.join(outside, 'computer-use', 'A.app')));
  assert.equal(fs.readFileSync(path.join(outside, 'config.toml'), 'utf8'), 'SKY_CUA_SERVICE_PATH = "x"\n');
  // codexHome == the root itself is not "inside" it
  assert.ok(cleanStaleComputerUseHelper({ root: x.root, codexHome: x.root }).skipped);
  // a root that is a symlink alias of the outside dir does not fool the check
  const alias = path.join(x.dir, 'alias'); fs.symlinkSync(outside, alias);
  assert.ok(cleanStaleComputerUseHelper({ root: x.root, codexHome: alias }).skipped);
  // symlinked computer-use inside the QA home: the link is removed, the target survives
  const target = path.join(x.dir, 'target'); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'keep'), 'k');
  fs.symlinkSync(target, path.join(x.home, 'computer-use'));
  const r2 = cleanStaleComputerUseHelper({ root: x.root, codexHome: x.home });
  assert.deepEqual([r2.state, r2.removedDir], ['symlink', true]);
  assert.equal(fs.existsSync(path.join(x.home, 'computer-use')), false);
  assert.equal(fs.readFileSync(path.join(target, 'keep'), 'utf8'), 'k');
  // no CODEX_HOME yet
  assert.ok(cleanStaleComputerUseHelper({ root: x.root, codexHome: path.join(x.root, 'nope') }).skipped);
});

test('cleanup and computer_use=false share one backup: whichever writes first saves the original', (t) => {
  const x = fixture(t);
  x.helper(STOCK_ID);
  fs.writeFileSync(x.cfg, `orig = 1\nSKY_CUA_SERVICE_PATH = "${x.home}/computer-use/h"\n`);
  cleanStaleComputerUseHelper({ root: x.root, codexHome: x.home });
  const r = ensureQaComputerUseOff({ codexHome: x.home, isolatedCodexHome: x.home });
  assert.equal(r.changed, true); assert.equal(r.backup, null, 'the backup already exists');
  assert.equal(fs.readFileSync(x.cfg, 'utf8'), 'orig = 1\n\n[features]\ncomputer_use = false\n');
  assert.match(fs.readFileSync(`${x.cfg}.qa-backup`, 'utf8'), /SKY_CUA_SERVICE_PATH/);
});

test('dangling reference given through a /var-style alias of the QA root is still recognised', (t) => {
  const x = fixture(t);
  const alias = path.join(x.dir, 'alias-root'); fs.symlinkSync(x.root, alias);
  fs.writeFileSync(x.cfg, `SKY_CUA_SERVICE_PATH = "${alias}/profiles/default/codex-home/computer-use/Gone.app"\n`);
  assert.equal(cleanStaleComputerUseHelper({ root: x.root, codexHome: x.home }).removedConfigLines.length, 1);
});
