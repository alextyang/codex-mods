// reseam-adapter.mjs: the UI seams of an existing pack are derived again for the same build, after everything else, and nothing else changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reseamPack, main } from './reseam-adapter.mjs';
import { sealTransforms, applyAll } from './transform.mjs';
import { isUiSeam, declarationFor } from './seams.mjs';
import { FIXTURE, fx, synth } from './fixtures/seam-fixture.mjs';

const MAIN = '.vite/build/main-Zzzzzzzz.js';
// a pack of the fixture build: one mandatory-looking edit in the main bundle, an old exposure of components, a stale UI seam, a host seam
const prior = (src) => sealTransforms([
  { id: 'cua-relocate-dir', seam: 'other', file: MAIN, op: 'replace-once', find: 'if(!F(e))return;', text: 'if(!F(e))return;/*iso*/' },
  { id: 'trusted-view-context', seam: 'trusted-sender', file: MAIN, op: 'insert-before-once', find: 'D.ipcMain.on(', text: '/*trusted*/' },
], (p) => src.read(p));
const pack = (src, over = {}) => ({ adapterVersion: '1.0.0', build: { version: '1.2.3', bundleVersion: '45' }, transforms: prior(src), components: {}, react: null, seams: { 'thread.panel': { exports: ['registerTabType'] } }, ...over });

test('reseamPack: the old transforms keep their hashes, the UI seams come after them, seams.hooks declares what applied, host seams stay', () => {
  const src = fx();
  const p = pack(src);
  const r = reseamPack(p, src);
  assert.deepEqual(r.pack.transforms.slice(0, 2), p.transforms, 'untouched, hashes included');
  assert.deepEqual(r.pack.transforms.slice(2).map((t) => t.id), ['seam-jsx', 'seam-lazy', 'seam-tap:commands', 'seam-tap:handlers', 'seam-tap:messages', 'seam-menu', 'seam-menu:file-tree', 'seam-menu:workspace-file', 'seam-menu:tab', 'seam-launcher', 'seam-markdown:components', 'seam-markdown:directives', 'seam-app-host']);
  assert.equal(r.pack.transforms.find((t) => t.id === 'seam-app-host').sha256Before, p.transforms[1].sha256After, 'the main-process seam continues the chain of the transforms before it');
  assert.deepEqual(r.pack.seams, { 'thread.panel': { exports: ['registerTabType'] }, hooks: declarationFor(r.pack.transforms) });
  assert.deepEqual(r.pack.seams.hooks, { abi: 1, jsx: 'seam-jsx', lazy: 'seam-lazy', taps: ['seam-tap:commands', 'seam-tap:handlers', 'seam-tap:messages'], menuItems: 'seam-menu', menuKinds: { 'file-tree': 'seam-menu:file-tree', 'workspace-file': 'seam-menu:workspace-file', tab: 'seam-menu:tab' }, launcher: 'seam-launcher', markdown: ['seam-markdown:components', 'seam-markdown:directives'], appHost: 'seam-app-host' });
  assert.deepEqual(r.report.added.length, 13); assert.deepEqual(r.report.removed, []);
  // the result applies to the stock source as the builder would
  assert.equal(applyAll(r.pack.transforms, (f) => src.read(f)).size, 5);
  // idempotent: a second run changes nothing
  const again = reseamPack(r.pack, src);
  assert.deepEqual(again.pack, r.pack); assert.deepEqual([again.report.added, again.report.removed], [[], []]);
});

test('reseamPack: stale UI seams are replaced, a group that does not derive is dropped and listed (the pack ships degraded), nothing is guessed', () => {
  const stale = { id: 'seam-jsx', seam: 'jsx', file: 'webview/assets/app-shared-aaaaaaaaaaaa.js', sha256Before: 'a'.repeat(64), sha256After: 'b'.repeat(64), op: 'replace-once', find: 'gone', text: 'x' };
  // the lazy helper is gone from this build: that group is missing, the others derive
  const broken = fx({ 'webview/assets/app-shared-aaaaaaaaaaaa.js': FIXTURE['webview/assets/app-shared-aaaaaaaaaaaa.js'].replace('Promise.resolve();if(t&&t.length>0)', 'Promise.resolve();if(t)') });
  const p2 = pack(broken, { transforms: [...prior(broken), stale], seams: { hooks: { abi: 0, jsx: 'seam-jsx' } } });
  const r = reseamPack(p2, broken);
  assert.deepEqual(r.pack.transforms.filter(isUiSeam).map((t) => t.id), ['seam-jsx', 'seam-tap:commands', 'seam-tap:handlers', 'seam-tap:messages', 'seam-menu', 'seam-menu:file-tree', 'seam-menu:workspace-file', 'seam-menu:tab', 'seam-launcher', 'seam-markdown:components', 'seam-markdown:directives', 'seam-app-host']);
  assert.deepEqual(r.report.missing.map((m) => m.item).filter((i) => !i.startsWith('expose:') && !i.startsWith('seam:props:') && i !== 'seam:markdown:text' && i !== 'seam:page-route' && i !== 'seam:destinations' && i !== 'seam:rail-mode' && i !== 'seam:copy' && i !== 'seam:attach' && i !== 'seam:review-action' && i !== 'seam:pr-create' && i !== 'seam:menu-command' && i !== 'seam:command' && i !== 'seam:sidebar-groups' && i !== 'seam:tab-visible' && i !== 'seam:responsive'), ['seam:lazy']);   // the fixture has no identity props' calls, markdown renderer, copy helper, command dispatcher nor sidebar
  assert.equal(r.pack.seams.hooks.lazy, undefined);
  assert.notEqual(r.pack.transforms.find((t) => t.id === 'seam-jsx').find, 'gone');
  // nothing of the UI seams derives for this build: no seams declaration at all (and the host seams of the pack are not invented)
  const bare = synth({ [MAIN]: 'D.ipcMain.on(g.Tt,e=>{if(!F(e))return;})' });
  const none = reseamPack({ ...pack(bare), seams: undefined }, bare);
  assert.equal('seams' in none.pack, false); assert.deepEqual(none.report.applied, []); assert.equal(none.report.declared, null);
});

test('reseamPack: a source that is not the pack\'s build is refused, because the pack\'s own transforms no longer apply to it', () => {
  const src = fx({ [MAIN]: FIXTURE[MAIN] + ' ' });
  assert.throws(() => reseamPack(pack(fx()), src), /sha256Before mismatch/);
});

test('main: reads the pack, re-seams it from --stock (a directory or asar), writes it back and a report; usage and unknown builds are errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-reseam-'));
  try {
    const root = join(dir, 'stock'); mkdirSync(join(root, 'webview', 'assets'), { recursive: true }); mkdirSync(join(root, '.vite', 'build'), { recursive: true });
    for (const [f, t] of Object.entries(FIXTURE)) writeFileSync(join(root, f), t);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.2.3', codexBuildNumber: 45 }));
    const src = fx();
    const packPath = join(dir, 'adapter.json'); writeFileSync(packPath, JSON.stringify(pack(src)));
    const logs = []; const errs = [];
    assert.equal(main(['--pack', packPath, '--stock', root, '--report', join(dir, 'r.json')], { log: (m) => logs.push(m), error: (m) => errs.push(m) }), 0, errs.join('\n'));
    const out = JSON.parse(readFileSync(packPath, 'utf8'));
    assert.equal(out.transforms.filter(isUiSeam).length, 13);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8')).applied, ['jsx', 'lazy', 'taps', 'menus', 'file-menu', 'workspace-file-menu', 'tab-menu', 'launcher', 'markdown', 'app-host']);
    assert.match(logs[0], /UI seam groups applied: jsx, lazy, taps, menus, file-menu, workspace-file-menu, tab-menu, launcher, markdown, app-host/);
    assert.equal(main([], { log() {}, error: (m) => errs.push(m) }), 2);
    // a stock of another build is not used
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '9.9.9', codexBuildNumber: 99 }));
    assert.equal(main(['--pack', packPath, '--stock', root], { log() {}, error: (m) => errs.push(m) }), 1);
    assert.match(errs.at(-1), /no stock source for 1\.2\.3 \(45\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
