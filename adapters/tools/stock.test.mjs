// The stock locator (stock.mjs): CODEXMODS_STOCK_ASAR, then the extraction .tmp/asar-<bundle>/, then the installed app; only the build asked for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locateStock, sourceFromDir, stockCandidates } from './stock.mjs';
import { makeAsar } from '../../builder/test/helpers.mjs';

const make = (t) => { const d = mkdtempSync(join(tmpdir(), 'cm-stock-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const extraction = (dir, { dotted, version = '1.2.3', build = 45 } = {}) => {
  mkdirSync(join(dir, 'webview', 'assets'), { recursive: true }); mkdirSync(join(dir, dotted ? '.vite' : 'vite', 'build'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version, ...(build === null ? {} : { codexBuildNumber: build }) }));
  writeFileSync(join(dir, dotted ? '.vite' : 'vite', 'build', 'main-AAAAAAAA.js'), 'main');
  writeFileSync(join(dir, 'webview', 'assets', 'app-initial-0123456789ab.js'), 'initial');
  writeFileSync(join(dir, 'webview', 'assets', 'logo.svg'), '<svg/>');
  return dir;
};

test('sourceFromDir: asar paths whichever way the extraction kept the .vite directory; package.json is listed; text is read, sizes are bytes', (t) => {
  for (const dotted of [false, true]) {
    const s = sourceFromDir(extraction(make(t), { dotted }));
    assert.deepEqual(s.list('.vite/build/'), ['.vite/build/main-AAAAAAAA.js'], `dotted=${dotted}`);
    assert.deepEqual(s.list('webview/assets/').sort(), ['webview/assets/app-initial-0123456789ab.js', 'webview/assets/logo.svg']);
    assert.equal(s.read('.vite/build/main-AAAAAAAA.js'), 'main'); assert.equal(s.size('webview/assets/logo.svg'), 6);
    assert.deepEqual(s.list('package.json'), ['package.json']);
  }
});

test('candidates are tried in order: CODEXMODS_STOCK_ASAR, .tmp/asar-<bundle>, the installed app; the first of the build asked for wins, others are skipped', (t) => {
  const repo = make(t); const env = make(t);
  extraction(env, { version: '2.0.0', build: 99 });
  mkdirSync(join(repo, '.tmp'), { recursive: true }); extraction(join(repo, '.tmp', 'asar-45'));
  assert.deepEqual(stockCandidates({ bundleVersion: '45', env: { CODEXMODS_STOCK_ASAR: env }, repo, installed: '/nope/app.asar' }), [env, join(repo, '.tmp', 'asar-45'), '/nope/app.asar']);
  assert.deepEqual(stockCandidates({ env: {}, repo, installed: '/x' }), ['/x']);
  // the env candidate is another build: skipped, the extraction of the bundle is used
  const s = locateStock({ bundleVersion: '45', version: '1.2.3', env: { CODEXMODS_STOCK_ASAR: env }, repo, installed: '/nope/app.asar' });
  assert.equal(s.path, join(repo, '.tmp', 'asar-45')); assert.equal(s.kind, 'dir'); assert.equal(s.pkg.codexBuildNumber, 45);
  // without a build asked for, the env candidate is the one
  assert.equal(locateStock({ env: { CODEXMODS_STOCK_ASAR: env }, repo, installed: '/nope/app.asar' }).path, env);
  // nothing of the build: null
  assert.equal(locateStock({ bundleVersion: '7', version: '7.0.0', env: {}, repo, installed: '/nope/app.asar' }), null);
  // a version alone also selects; a package.json without a build number is judged by its version
  const noNumber = make(t); extraction(noNumber, { build: null, version: '3.1.4' });
  assert.ok(locateStock({ bundleVersion: '3', version: '3.1.4', env: { CODEXMODS_STOCK_ASAR: noNumber }, repo, installed: null }));
  assert.equal(locateStock({ bundleVersion: '3', version: '3.1.5', env: { CODEXMODS_STOCK_ASAR: noNumber }, repo, installed: null }), null);
});

test('an app.asar file is a candidate too (the installed app\'s form): same source, with the asar reader attached; a broken path is skipped', (t) => {
  const d = make(t);
  const { buffer } = makeAsar({ 'package.json': JSON.stringify({ version: '1.2.3', codexBuildNumber: 45 }), '.vite/build/main-AAAAAAAA.js': 'main', 'webview/assets/app-initial-0123456789ab.js': 'initial' });
  const file = join(d, 'app.asar'); writeFileSync(file, buffer);
  const s = locateStock({ bundleVersion: '45', env: { CODEXMODS_STOCK_ASAR: file }, repo: d, installed: null });
  assert.equal(s.kind, 'asar'); assert.ok(s.asar.headerSha256);
  assert.deepEqual(s.source.list('.vite/build/'), ['.vite/build/main-AAAAAAAA.js']); assert.equal(s.source.read('webview/assets/app-initial-0123456789ab.js'), 'initial');
  s.close();
  writeFileSync(join(d, 'broken.asar'), 'not an asar');
  assert.equal(locateStock({ env: { CODEXMODS_STOCK_ASAR: join(d, 'broken.asar') }, repo: d, installed: null }), null);
});
