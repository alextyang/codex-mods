import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { refreshAdapter, reconcileDeclarations, resolveBuildFile } from '../refresh-adapter.mjs';
import { ISOLATION_BASELINE_IDS } from '../build.mjs';
import { makeStockApp, tmpdir, sha, PKG_MAIN, MAIN_JS } from './helpers.mjs';

// A "new stock build" whose app.asar contains MAIN_JS; the previous pack carries one transform that still anchors.
const TRANSFORM = (id, find = 'const seam = 1;', file = PKG_MAIN) => ({ id, seam: 'other', file, sha256Before: sha(MAIN_JS), sha256After: sha('x'), op: 'replace-once', find, text: 'const seam = 2;' });
const previous = (o = {}) => ({
  adapterVersion: '1.0.0', build: { version: '0.9', bundleVersion: '1', asarSha256: 'a'.repeat(64), electronVersion: '1' },
  backend: { codexPath: 'Resources/codex-cli/bin/codex', method: 'replace' }, asarPackageJson: 'package.json',
  protocol: { handshake: {}, affinityKeyPaths: [], affinityCreators: [], methods: { clientRequests: [], clientNotifications: [], serverRequests: [], serverNotifications: [] } },
  transforms: [TRANSFORM('cua-container')], anchors: {}, components: {}, react: null, theme: {}, actions: {},
  binaryPatches: [{ id: 'old-patch', file: 'x', sha256Before: 'b'.repeat(64), offset: 1, before: '00', after: '01', sha256After: 'c'.repeat(64), justification: 'old build' }],
  ...o,
});
const base = (t, opts) => {
  const dir = tmpdir(t); const stock = makeStockApp(dir, opts);
  return { dir, stock: stock.app, out: path.join(dir, 'adapters', '1.2.3-45') };
};
const common = { runCodex: async () => { throw new Error('no codex in tests'); }, allowNoBaseline: true };
const derived = (ids) => async () => ({ patches: ids.map((id) => ({ id, file: 'f', sha256Before: 'd'.repeat(64), offset: 0, before: '00', after: '01', sha256After: 'e'.repeat(64), justification: 'new build' })), missing: [] });
/** A stand-in for the adapters/tools derivers: edits of the new build (what the real ones locate by anchors), not the previous pack's. */
const draft = (id, over = {}) => ({ id, seam: 'other', file: PKG_MAIN, op: 'replace-once', find: 'const seam = 1;', text: 'const seam = 3; /* derived */', ...over });
const deriveT = (...drafts) => async (source) => { assert.ok(source.list('.vite/build/').length > 0, 'the deriver gets a source over the new asar'); return { drafts, missing: [] }; };

test('refresh: binary patches are re-derived for the new build, never carried forward', async (t) => {
  const x = base(t);
  const r = await refreshAdapter({ ...common, previous: previous(), stockApp: x.stock, outDir: x.out, deriveBinaryPatches: derived(['keychain-service-name']), deriveMandatoryTransforms: deriveT(draft('cua-container')) });
  assert.deepEqual(r.adapter.binaryPatches.map((p) => p.id), ['keychain-service-name']);
  assert.equal(r.report.binaryPatches.derived, 1); assert.equal(r.report.binaryPatches.previous, 1);
  assert.ok(fs.existsSync(path.join(x.out, 'adapter.json')));
  assert.match(fs.readFileSync(path.join(x.out, 'NOTES.md'), 'utf8'), /none carried forward/);
  // nothing derived: the key is gone, not the old patches
  const y = base(t);
  const r2 = await refreshAdapter({ ...common, previous: previous(), stockApp: y.stock, outDir: y.out, deriveBinaryPatches: derived([]), deriveMandatoryTransforms: deriveT(draft('cua-container')) });
  assert.equal('binaryPatches' in r2.adapter, false);
});

test('refresh: mandatory transforms are derived for the new build, never replayed from the previous pack', async (t) => {
  const x = base(t);
  // the previous find still matches the new bundle: a replay would succeed, but the derived edit is the one the pack gets
  const r = await refreshAdapter({ ...common, previous: previous({ mandatoryEdits: ['cua-container'] }), stockApp: x.stock, outDir: x.out, deriveBinaryPatches: derived([]), deriveMandatoryTransforms: deriveT(draft('cua-container')) });
  const [tr] = r.adapter.transforms;
  assert.deepEqual([tr.id, tr.text], ['cua-container', 'const seam = 3; /* derived */']);
  assert.equal(tr.sha256Before, sha(MAIN_JS));
  assert.equal(tr.sha256After, sha(MAIN_JS.replace('const seam = 1;', 'const seam = 3; /* derived */')));
  assert.deepEqual(r.report.transforms['cua-container'], { missed: false, derived: true });
  assert.match(fs.readFileSync(path.join(x.out, 'NOTES.md'), 'utf8'), /derived from this build's app\.asar \(not replayed\): cua-container/);
});

test('refresh: a missing mandatory transform or binary patch means NO pack and an error naming it', async (t) => {
  // the deriver cannot find the site (the previous find would still match: it is not tried)
  const a = base(t);
  await assert.rejects(refreshAdapter({ ...common, previous: previous({ mandatoryEdits: ['cua-container'] }), stockApp: a.stock, outDir: a.out, deriveBinaryPatches: derived([]),
    deriveMandatoryTransforms: async () => ({ drafts: [], missing: [{ item: 'transform:cua-container', mandatory: true, tried: 'the container id occurs 0 times' }] }) }),
  (e) => e.code === 'Incompatible' && /cua-container/.test(e.message) && /occurs 0 times/.test(e.message) && /not derived for this build/.test(e.message));
  assert.equal(fs.existsSync(a.out), false, 'no pack written');
  assert.deepEqual(fs.existsSync(path.dirname(a.out)) ? fs.readdirSync(path.dirname(a.out)) : [], [], 'no temp dir left');
  // a derived edit that no longer applies after the other transforms of its file
  const c = base(t);
  await assert.rejects(refreshAdapter({ ...common, previous: previous({ mandatoryEdits: ['cua-container'] }), stockApp: c.stock, outDir: c.out, deriveBinaryPatches: derived([]),
    deriveMandatoryTransforms: deriveT(draft('cua-container', { find: 'text that is not in the bundle' })) }),
  (e) => e.code === 'Incompatible' && /cua-container/.test(e.message) && /occurs 0 times/.test(e.message));
  assert.equal(fs.existsSync(c.out), false);
  // a deriver miss that names no id the previous pack knew is still a refusal
  const d = base(t);
  await assert.rejects(refreshAdapter({ ...common, previous: previous({ mandatoryEdits: ['cua-container'] }), stockApp: d.stock, outDir: d.out, deriveBinaryPatches: derived([]),
    deriveMandatoryTransforms: async () => ({ drafts: [draft('cua-container')], missing: [{ item: 'transform:managed-config-no-persist', mandatory: true, tried: 'anchor changed' }] }) }),
  (e) => e.code === 'Incompatible' && /managed-config-no-persist/.test(e.message) && /anchor changed/.test(e.message));
  assert.equal(fs.existsSync(d.out), false);
  // binary patch the deriver could not produce
  const b = base(t);
  await assert.rejects(refreshAdapter({ ...common, previous: previous({ mandatoryEdits: ['cua-container', 'keychain-service-name'] }), stockApp: b.stock, outDir: b.out, deriveMandatoryTransforms: deriveT(draft('cua-container')),
    deriveBinaryPatches: async () => ({ patches: [], missing: [{ item: 'binaryPatches:keychain-service-name', tried: 'no framework binary found' }] }) }),
  (e) => e.code === 'Incompatible' && /keychain-service-name/.test(e.message) && /no framework binary found/.test(e.message));
  assert.equal(fs.existsSync(b.out), false);
});

test('refresh: with every mandatory edit present the pack is written and keeps the mandatory list', async (t) => {
  const x = base(t);
  const r = await refreshAdapter({ ...common, previous: previous({ mandatoryEdits: ['cua-container', 'keychain-service-name'] }), stockApp: x.stock, outDir: x.out, deriveBinaryPatches: derived(['keychain-service-name']), deriveMandatoryTransforms: deriveT(draft('cua-container')) });
  assert.deepEqual(r.adapter.mandatoryEdits, ['cua-container', 'keychain-service-name']);
  assert.deepEqual(r.adapter.transforms.map((tt) => tt.id), ['cua-container']);
  assert.match(fs.readFileSync(path.join(x.out, 'NOTES.md'), 'utf8'), /mandatory edits all present/);
});

test('refresh: ids that embedded a content-hashed chunk name are read by role, and the new file is the one of that role', async (t) => {
  const NEW = '.vite/build/main-CLu1A25j.js';
  const x = base(t, { asarFiles: { [NEW]: 'a;b=`com.openai.sky.CUAService`,c;' } });
  const old = TRANSFORM('cua-bundle-id:main-CqEoQDOU.js:1', 'b=`com.openai.sky.CUAService`', '.vite/build/main-CqEoQDOU.js');
  const d = draft('cua-bundle-id:main:1', { file: NEW, find: '`com.openai.sky.CUAService`,c', text: '`com.openai.sky.CUAServicf`,c' });
  const r = await refreshAdapter({ ...common, previous: previous({ transforms: [old], mandatoryEdits: ['cua-bundle-id:main-CqEoQDOU.js:1'] }), stockApp: x.stock, outDir: x.out, deriveBinaryPatches: derived([]), deriveMandatoryTransforms: deriveT(d) });
  assert.deepEqual(r.adapter.transforms.map((tr) => [tr.id, tr.file]), [['cua-bundle-id:main:1', NEW]]);
  assert.deepEqual(r.adapter.mandatoryEdits, ['cua-bundle-id:main:1']);
  assert.equal(r.adapter.transforms[0].sha256After, sha('a;b=`com.openai.sky.CUAServicf`,c;'));
  // the same pack with the site gone: the family has no site in this build, so it is missing (a bundle-id site is one of a family whose sites
  // are the build's: 22943 split its main process; the family is required whole, and the deriver's dry run checks that no stock id is left)
  const y = base(t, { asarFiles: { [NEW]: 'nothing' } });
  await assert.rejects(refreshAdapter({ ...common, previous: previous({ transforms: [old], mandatoryEdits: ['cua-bundle-id:main-CqEoQDOU.js:1'] }), stockApp: y.stock, outDir: y.out, deriveBinaryPatches: derived([]), deriveMandatoryTransforms: deriveT() }),
    (e) => e.code === 'Incompatible' && /cua-bundle-id:\*/.test(e.message));
});

test('refresh: other transforms are replayed against the file of the same role (name without its hash), once, and are dropped when ambiguous or gone', async (t) => {
  const x = base(t, { asarFiles: { '.vite/build/aux-BBBBBBBB.js': 'aa zzz bb', '.vite/build/amb-1111111a.js': 'zzz', '.vite/build/amb-2222222b.js': 'zzz' } });
  const T = (id, file) => ({ ...TRANSFORM(id, 'zzz', file), text: 'ZZZ' });
  const r = await refreshAdapter({ ...common, previous: previous({ transforms: [T('u1', '.vite/build/aux-AAAAAAAA.js'), T('u2', '.vite/build/amb-0000000c.js'), T('u3', '.vite/build/gone-0000000c.js')] }), stockApp: x.stock, outDir: x.out, deriveBinaryPatches: derived([]) });
  assert.deepEqual(r.adapter.transforms.map((tr) => [tr.id, tr.file, tr.sha256After]), [['u1', '.vite/build/aux-BBBBBBBB.js', sha('aa ZZZ bb')]]);
  assert.deepEqual(r.report.transforms.u1, { missed: false, file: '.vite/build/aux-BBBBBBBB.js' });
  assert.equal(r.report.transforms.u2.missed, true); assert.equal(r.report.transforms.u3.missed, true);
  assert.equal(resolveBuildFile({ has: () => false, files: () => [['.vite/build/aux-BBBBBBBB.js', {}], ['.vite/build/aux-BBBBBBBB.css', {}], ['webview/aux-CCCCCCCC.js', {}]] }, '.vite/build/aux-AAAAAAAA.js'), '.vite/build/aux-BBBBBBBB.js', 'same directory, extension and stem');
});

test('refresh: a seam that works only whole (the trusted sender) is dropped whole when one of its transforms is lost', async (t) => {
  const x = base(t, { asarFiles: { '.vite/build/m.js': 'one two three' } });
  const S = (id, find) => ({ ...TRANSFORM(id, find, '.vite/build/m.js'), seam: 'trusted-sender', text: find.toUpperCase() });
  const r = await refreshAdapter({ ...common, previous: previous({ transforms: [S('trusted-view-context', 'one'), S('trusted-view-sender', 'gone'), S('trusted-view-startup', 'three'), TRANSFORM('keep', 'two', '.vite/build/m.js')] }), stockApp: x.stock, outDir: x.out, deriveBinaryPatches: derived([]) });
  assert.deepEqual(r.adapter.transforms.map((tr) => tr.id), ['keep']);
  assert.equal(r.adapter.transforms[0].sha256Before, sha('one two three'), 'the chain is rebuilt without the dropped seam');
  assert.match(r.report.transforms['trusted-view-startup'].reason, /works only whole/);
  assert.match(r.report.transforms['trusted-view-sender'].reason, /not found/);
});

test('reconcileDeclarations: components, react and seams are kept only as far as the surviving transforms deliver them', () => {
  const exposure = (keys) => `;(()=>{for(let[k,g]of Object.entries({${keys.map((k) => `${JSON.stringify(k)}:()=>x`).join(',')}}))0})();\n`;
  const prev = { components: { Button: 'Button', Switch: 'Switch' }, react: { react: 'react', reactDom: 'reactDom' },
    seams: { 'thread.header': { transform: 'seam-host:thread-header', exports: ['AppShell', 'useScope'] }, 'thread.panel': { exports: ['registerTabType'] } } };
  const t = (id, seam, text = 'x') => ({ id, seam, text });
  // everything survives
  const all = reconcileDeclarations(prev, [t('e1', 'components', exposure(['Button', 'Switch', 'react', 'reactDom', 'AppShell', 'useScope', 'registerTabType'])), t('seam-host:thread-header', 'host')]);
  assert.deepEqual([all.components, all.react, all.seams], [prev.components, prev.react, prev.seams]);
  assert.deepEqual(all.report, { components: [], react: false, seams: [] });
  // the host seam is lost, one chunk's exposures are lost
  const part = reconcileDeclarations(prev, [t('e1', 'components', exposure(['Button', 'react', 'reactDom', 'registerTabType']))]);
  assert.deepEqual(part.components, { Button: 'Button' });
  assert.deepEqual(part.react, prev.react);
  assert.deepEqual(Object.keys(part.seams), ['thread.panel']);
  assert.deepEqual(part.report, { components: ['Switch'], react: false, seams: ['thread.header'] });
  // nothing survives
  const none = reconcileDeclarations(prev, []);
  assert.deepEqual([none.components, none.react, none.seams], [{}, null, {}]);
  assert.deepEqual(none.report, { components: ['Button', 'Switch'], react: true, seams: ['thread.header', 'thread.panel'] });
  // a pack that never declared anything stays empty
  assert.deepEqual(reconcileDeclarations({ components: {}, react: null }, []).report, { components: [], react: false, seams: [] });
});

test('refresh: what the dropped transforms provided leaves the pack\'s declarations, and the report says so', async (t) => {
  const x = base(t);
  const prev = previous({ transforms: [{ ...TRANSFORM('expose-components:app', 'gone'), seam: 'components', text: ';({"Button":()=>x})' }], components: { Button: 'Button' }, react: { react: 'react', reactDom: 'reactDom' },
    seams: { 'thread.header': { transform: 'seam-host:thread-header', exports: ['AppShell'] } } });
  const r = await refreshAdapter({ ...common, previous: prev, stockApp: x.stock, outDir: x.out, deriveBinaryPatches: derived([]) });
  assert.deepEqual([r.adapter.transforms, r.adapter.components, r.adapter.react], [[], {}, null]);
  assert.equal('seams' in r.adapter, false);
  assert.deepEqual(r.report.declarations, { components: ['Button'], react: true, seams: ['thread.header'] });
  const notes = fs.readFileSync(path.join(x.out, 'NOTES.md'), 'utf8');
  assert.match(notes, /components no longer exposed, dropped from the pack: Button/);
  assert.match(notes, /host seams no longer provided, dropped from the pack: thread\.header/);
});

test('refresh: the app version declared in the backend overrides follows the new build', async (t) => {
  const x = base(t);
  const overrides = { notify: ['${computerUseDir}/x', 'turn-ended'], 'mcp_servers.node_repl': { command: '${resources}/node_repl', env: { BROWSER_USE_CODEX_APP_VERSION: '0.9', OTHER: '0.9.1', LIST: ['0.9'] } } };
  const r = await refreshAdapter({ ...common, previous: previous({ transforms: [], backend: { codexPath: 'Resources/codex-cli/bin/codex', method: 'replace', configOverrides: overrides } }), stockApp: x.stock, outDir: x.out, deriveBinaryPatches: derived([]) });
  const nr = r.adapter.backend.configOverrides['mcp_servers.node_repl'];
  assert.deepEqual([nr.env.BROWSER_USE_CODEX_APP_VERSION, nr.env.OTHER, nr.env.LIST], ['1.2.3', '0.9.1', ['1.2.3']], 'only values that are exactly the previous version');
  assert.deepEqual(r.report.retargetedOverrides, ['backend.configOverrides.mcp_servers.node_repl.env.BROWSER_USE_CODEX_APP_VERSION', 'backend.configOverrides.mcp_servers.node_repl.env.LIST[0]']);
  assert.equal(overrides['mcp_servers.node_repl'].env.BROWSER_USE_CODEX_APP_VERSION, '0.9', 'the previous pack object is not modified');
  assert.match(fs.readFileSync(path.join(x.out, 'NOTES.md'), 'utf8'), /app version was replaced by 1\.2\.3/);
});

test('refresh: the isolation baseline is enforced, also from an older pack that lacks mandatoryEdits', async (t) => {
  const strictOpts = { runCodex: async () => { throw new Error('no codex'); } };
  const fwIds = ISOLATION_BASELINE_IDS.filter((id) => id !== 'cua-container');
  const all = [...fwIds, 'cua-bundle-id:x:1', 'cua-container:y:1'];
  // an old pack without the field and a deriver that yields only some of the baseline: refused, listing exactly what is missing
  const a = base(t);
  await assert.rejects(refreshAdapter({ ...strictOpts, previous: previous(), stockApp: a.stock, outDir: a.out, deriveMandatoryTransforms: deriveT(),
    deriveBinaryPatches: derived(['keychain-service-name', 'keychain-service-name-account', 'aura-fallback-service', 'aura-fallback-account', 'cua-bundle-id:x:1']) }),
  (e) => e.code === 'Incompatible' && ['cua-relocate-dir', 'cua-relocate-config', 'cua-relocate-installer', 'cua-service-path-env', 'cua-container:*'].every((m) => e.details.missing.includes(m)) && !e.details.missing.includes('keychain-service-name'));
  assert.equal(fs.existsSync(a.out), false);
  // the real derivers fail closed on an asar without the app's code: nothing is written
  const c = base(t);
  await assert.rejects(refreshAdapter({ ...strictOpts, previous: previous(), stockApp: c.stock, outDir: c.out, deriveBinaryPatches: derived(all) }),
    (e) => e.code === 'Incompatible' && /transform:cua-container/.test(e.message) && /transform:managed-config-no-persist/.test(e.message) && /transform:cua-skills-no-expose/.test(e.message));
  assert.equal(fs.existsSync(c.out), false);
  // everything derivable: written, mandatoryEdits now carries the baseline plus the prefixed ids
  const b = base(t);
  const r = await refreshAdapter({ ...strictOpts, previous: previous(), stockApp: b.stock, outDir: b.out, deriveBinaryPatches: derived(all), deriveMandatoryTransforms: deriveT(draft('cua-container')) });
  for (const id of ISOLATION_BASELINE_IDS) assert.ok(r.adapter.mandatoryEdits.includes(id), id);
  assert.ok(r.adapter.mandatoryEdits.includes('cua-bundle-id:x:1') && r.adapter.mandatoryEdits.includes('cua-container:y:1'));
  assert.deepEqual(r.report.mandatoryEdits, r.adapter.mandatoryEdits);
});

test('refresh: a newly derived mandatory edit (N1, cua-skills-no-expose) is listed, and from then on a refresh that cannot derive or apply it once writes no pack', async (t) => {
  const N1 = 'cua-skills-no-expose';
  const skills = draft(N1, { find: 'const seam = 1;', text: 'const seam = 1;return;' });
  // the previous pack predates N1: the edit is derived anyway, applied once and listed as mandatory
  const a = base(t);
  const r = await refreshAdapter({ ...common, previous: previous({ mandatoryEdits: ['cua-container'] }), stockApp: a.stock, outDir: a.out, deriveBinaryPatches: derived([]),
    deriveMandatoryTransforms: deriveT(draft('cua-container', { find: 'const seam', text: 'const seam' }), skills) });
  assert.deepEqual(r.adapter.transforms.map((x) => x.id), ['cua-container', N1]);
  assert.equal(r.adapter.transforms.filter((x) => x.id === N1).length, 1);
  assert.ok(r.adapter.mandatoryEdits.includes(N1));
  assert.deepEqual(r.report.transforms[N1], { missed: false, derived: true });
  const next = JSON.parse(fs.readFileSync(path.join(a.out, 'adapter.json'), 'utf8'));
  // the next refresh: the deriver misses it -> refused, no pack
  const b = base(t);
  await assert.rejects(refreshAdapter({ ...common, previous: next, stockApp: b.stock, outDir: b.out, deriveBinaryPatches: derived([]),
    deriveMandatoryTransforms: async () => ({ drafts: [draft('cua-container')], missing: [{ item: `transform:${N1}`, mandatory: true, tried: '"Bundled CUA skill version mismatch" occurs 0 times (expected exactly 1)' }] }) }),
  (e) => e.code === 'Incompatible' && e.details.missing.includes(N1) && /Bundled CUA skill version mismatch/.test(e.message));
  assert.equal(fs.existsSync(b.out), false, 'no pack written');
  // derived, but its find no longer occurs exactly once after the other edits of the file -> refused, no pack
  const c = base(t);
  await assert.rejects(refreshAdapter({ ...common, previous: next, stockApp: c.stock, outDir: c.out, deriveBinaryPatches: derived([]), deriveMandatoryTransforms: deriveT(draft('cua-container'), skills) }),
    (e) => e.code === 'Incompatible' && e.details.missing.includes(N1) && /occurs 0 times after the other transforms/.test(e.message));
  assert.equal(fs.existsSync(c.out), false, 'no pack written');
});

// ---- the UI seams (docs/design/presentations.md V1): derived again for every build, atomic groups after every other transform
const uiDraft = (id, seam, over = {}) => ({ id, seam, file: PKG_MAIN, op: 'replace-once', find: 'const seam = 1;', text: 'const seam = 1;/*ui*/', ...over });
const uiGroups = (...groups) => async (source) => { assert.ok(source.list('.vite/build/').length > 0, 'the deriver gets a source over the new asar'); return { groups, missing: [] }; };
const g = (id, seam, ...drafts) => ({ id, seam, drafts });

test('refresh: UI seams are derived for the new build, applied after the mandatory edits (which keep their hashes) and declared in seams.hooks with the ABI', async (t) => {
  const x = base(t);
  const mandatory = draft('cua-container', { find: 'console.log("main");', text: 'console.log("main"); /* iso */' });
  const jsx = uiDraft('seam-jsx', 'jsx', { find: 'const seam = 1;', text: 'const seam = 1;/*jsx*/' });
  const taps = [uiDraft('seam-tap:commands', 'tap', { find: '/*jsx*/', text: '/*c*/' }), uiDraft('seam-tap:handlers', 'tap', { find: '/*c*/', text: '/*c*//*h*/' }), uiDraft('seam-tap:messages', 'tap', { find: '/*h*/', text: '/*h*//*m*/' })];
  const block = uiDraft('seam-expose:main', 'expose', { op: 'insert-after-once', find: '/*m*/', text: 'd("modal",()=>1);' });
  const r = await refreshAdapter({ ...common, previous: previous({ mandatoryEdits: ['cua-container'] }), stockApp: x.stock, outDir: x.out, deriveBinaryPatches: derived([]),
    deriveMandatoryTransforms: deriveT(mandatory), deriveUiSeams: uiGroups(g('jsx', 'jsx', jsx), g('taps', 'tap', ...taps), g('seam-expose:main', 'expose', block)) });
  assert.deepEqual(r.adapter.transforms.map((tr) => tr.id), ['cua-container', 'seam-jsx', 'seam-tap:commands', 'seam-tap:handlers', 'seam-tap:messages', 'seam-expose:main']);
  const [m0, ...ui] = r.adapter.transforms;
  assert.equal(m0.sha256Before, sha(MAIN_JS), 'the mandatory edit still starts from the stock file');
  assert.equal(ui[0].sha256Before, m0.sha256After, 'the first UI seam continues the chain of the mandatory edits');
  ui.forEach((tr, i) => { if (i) assert.equal(tr.sha256Before, ui[i - 1].sha256After); });
  assert.deepEqual(r.adapter.seams, { hooks: { abi: 1, jsx: 'seam-jsx', taps: ['seam-tap:commands', 'seam-tap:handlers', 'seam-tap:messages'], exposures: { modal: 'seam-expose:main' } } });
  assert.deepEqual(r.report.uiSeams.applied, ['jsx', 'taps', 'seam-expose:main']); assert.deepEqual(r.report.uiSeams.dropped, []);
  assert.deepEqual(r.report.transforms['seam-jsx'], { missed: false, derived: true, uiSeam: true });
  const notes = fs.readFileSync(path.join(x.out, 'NOTES.md'), 'utf8');
  assert.match(notes, /## UI seams/); assert.match(notes, /applied \(atomic groups\): jsx, taps, seam-expose:main/); assert.match(notes, /seams\.hooks \(abi 1\): abi, jsx, taps, exposures|seams\.hooks \(abi 1\): jsx, taps, exposures/);
  assert.doesNotMatch(notes, /not replayed\): .*seam-jsx/, 'the UI seams are not listed among the mandatory edits');
});

test('refresh: a UI seam group applies whole or not at all; a dropped group is listed and not declared, the others stand; host seams are kept', async (t) => {
  const x = base(t);
  const ok = uiDraft('seam-jsx', 'jsx');
  const taps = [uiDraft('seam-tap:commands', 'tap', { find: '/*ui*/', text: '/*ui*//*c*/' }), uiDraft('seam-tap:handlers', 'tap', { find: 'a site that is not there', text: 'x' }), uiDraft('seam-tap:messages', 'tap', { find: '/*c*/', text: '/*c*//*m*/' })];
  const lazy = uiDraft('seam-lazy', 'lazy', { find: '/*c*/', text: '/*c*//*l*/', file: '.vite/build/not-here.js' });
  const prev = previous({ mandatoryEdits: ['cua-container'], seams: { 'thread.panel': { exports: ['registerTabType'] } }, components: { Button: 'Button' },
    transforms: [TRANSFORM('cua-container'), { ...TRANSFORM('seam-jsx'), seam: 'jsx' }, { ...TRANSFORM('seam-app-host'), seam: 'app-host' }, { ...TRANSFORM('expose-components:app', 'gone'), seam: 'components', text: ';({"Button":()=>x})' }] });
  const r = await refreshAdapter({ ...common, previous: prev, stockApp: x.stock, outDir: x.out, deriveBinaryPatches: derived([]), deriveMandatoryTransforms: deriveT(draft('cua-container', { find: 'console.log("main");', text: 'console.log("main"); /* iso */' })),
    deriveUiSeams: async () => ({ groups: [g('jsx', 'jsx', ok), g('taps', 'tap', ...taps), g('lazy', 'lazy', lazy)], missing: [{ item: 'seam:app-host', tried: 'no main bundle' }] }) });
  assert.deepEqual(r.adapter.transforms.map((tr) => tr.id), ['cua-container', 'seam-jsx'], 'the old UI seam transforms are not replayed; the components exposure that no longer anchors is dropped as before');
  assert.deepEqual(r.report.uiSeams.dropped.map((d) => d.id), ['taps', 'lazy']);
  assert.match(r.report.uiSeams.dropped[0].why, /occurs 0 times/); assert.match(r.report.uiSeams.dropped[1].why, /not found in the new bundle/);
  assert.equal(r.report.transforms['seam-tap:commands'].missed, true, 'not even the tap sites that still matched');
  assert.ok(!r.adapter.transforms.some((tr) => tr.seam === 'tap'));
  assert.equal(r.report.transforms['seam-app-host'].missed, true); assert.match(r.report.transforms['seam-app-host'].reason, /not derived for this build/);
  assert.deepEqual(r.adapter.seams, { hooks: { abi: 1, jsx: 'seam-jsx' } }, 'a host seam whose exports are no longer exposed is dropped; hooks declares only what applied');
  const notes = fs.readFileSync(path.join(x.out, 'NOTES.md'), 'utf8');
  assert.match(notes, /dropped group taps/); assert.match(notes, /dropped group lazy/); assert.match(notes, /did not derive seam:app-host: no main bundle/);
  // nothing applies: no hooks, no seams at all
  const y = base(t);
  const none = await refreshAdapter({ ...common, previous: previous(), stockApp: y.stock, outDir: y.out, deriveBinaryPatches: derived([]), deriveMandatoryTransforms: deriveT(draft('cua-container')), deriveUiSeams: uiGroups() });
  assert.equal('seams' in none.adapter, false);
  assert.match(fs.readFileSync(path.join(y.out, 'NOTES.md'), 'utf8'), /nothing declared: the pack ships without UI seams/);
});

test('refresh: a UI seam deriver that fails to run is a finding, never a refusal', async (t) => {
  const x = base(t);
  const r = await refreshAdapter({ ...common, previous: previous(), stockApp: x.stock, outDir: x.out, deriveBinaryPatches: derived([]), deriveMandatoryTransforms: deriveT(draft('cua-container')), deriveUiSeams: async () => { throw new Error('scanner exploded'); } });
  assert.deepEqual(r.report.uiSeams.applied, []);
  assert.match(r.report.uiSeams.missing[0].tried, /scanner exploded/);
  assert.deepEqual(r.adapter.transforms.map((tr) => tr.id), ['cua-container']);
});

test('reconcileDeclarations: seams.hooks is not a host seam; it is declared again from the transforms, never carried over', () => {
  const prev = { components: {}, react: null, seams: { hooks: { abi: 1, jsx: 'seam-jsx' }, 'thread.panel': { exports: ['registerTabType'] } } };
  const part = reconcileDeclarations(prev, []);
  assert.deepEqual(part.seams, {}); assert.deepEqual(part.report.seams, ['thread.panel']);
  const kept = reconcileDeclarations(prev, [{ id: 'e', seam: 'components', text: ';({"registerTabType":()=>x})' }]);
  assert.deepEqual(Object.keys(kept.seams), ['thread.panel']);
});
