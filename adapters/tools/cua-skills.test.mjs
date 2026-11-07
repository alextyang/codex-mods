// N1: the copy must not copy or remove the CUA skills in the plugin cache it shares with the stock app. Synthetic fixtures (shapes copied from the 20770
// main bundle), plus tests marked "stock" that read the stock app's code of the build in their title (CODEXMODS_STOCK_ASAR, the extraction .tmp/asar-<bundle>/
// or the installed app; read-only, never launched) and skip when none of them is that build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveCuaSkillsTransform, exposedCuaSkills, locateSkillExposure, matchClose, usedResults, SKILLS_ID, MISMATCH } from './cua-skills.mjs';
import { sealTransforms, applyAll } from './transform.mjs';
import { mandatoryEditIds } from './generate-adapter.mjs';
import { locateStock } from './stock.mjs';

const MAIN = '.vite/build/main-X.js';
// the skill exposure and its caller as in the 20770 main bundle (identifiers as minified there; the caller shortened around the call)
const MAP = 'var Wne={[i.Bo]:`control-in-app-browser`,[i.Uo]:`control-chrome`,[i.Ho]:`control-chrome`,[i.Vo]:`control-chrome`,[i.qo]:`computer-use`};';
const FN = 'async function Gne(e){let t=la(e).flatMap(e=>e.plugins.map(t=>({marketplace:e,plugin:t}))),n=await Promise.all(t.map(async({marketplace:t,plugin:n})=>{let r=Wne[n.name],a=n.name===i.qo,o=!e.cuaReplSurfaces.includes(a?`computer`:`browser`);if(!n.installed||r==null||a&&e.platform!==`darwin`)return null;let s=n.enabled&&n.availability===`AVAILABLE`;if(!o&&!s)return null;let c=i.Kt({codexHome:e.codexHome,localVersion:n.localVersion,marketplaceName:t.name,pluginName:n.name}),l=S.default.join(c,`skills`,r);if((0,b.existsSync)(S.default.join(l,`SKILL.md`))===o)return null;let u=await Ho({...e,marketplaceName:t.name,marketplaceRoot:a?Pa({codexHome:e.codexHome,marketplaceName:t.name}):void 0,pluginName:n.name});if(u==null||u.version!==n.localVersion){if(!s)return null;throw Error(`Bundled CUA skill version mismatch: ${n.name}`)}let d=S.default.join(u.path,`skills`,r);return await(0,k.access)(S.default.join(d,`SKILL.md`)),{sourcePath:d,installedPath:l,pluginRoot:c,exposeSkills:o}}));await Promise.all(n.map(async e=>{if(e!=null){if(!e.exposeSkills)await(0,k.rm)(e.installedPath,{recursive:!0,force:!0});else{let t=S.default.join(e.pluginRoot,`.codex-plugin`,`skill-${(0,_.randomUUID)()}`);try{await(0,k.cp)(e.sourcePath,t,{recursive:!0}),await(0,k.rm)(e.installedPath,{recursive:!0,force:!0}),await(0,k.mkdir)(S.default.dirname(e.installedPath),{recursive:!0}),await(0,k.rename)(t,e.installedPath)}finally{await(0,k.rm)(t,{recursive:!0,force:!0})}}}}))}';
const CALLER = 'async function Ss(e,S,v,g,b){let w=!1;if(e.hostConfig.kind===`local`){w=await ka(),await Gne({cuaReplSurfaces:w?S:[],codexHome:v,marketplaceName:`openai-bundled`,marketplaces:g,platform:b.platform}),e!=null&&w&&Oa(e,S)}return w}';
const FIXTURE = [MAP, FN, CALLER, 'function hs(e){return`${e.root}/x`}'].join('\n');
const files = (main = FIXTURE) => ({ [MAIN]: main });
const source = (f) => ({ list: (p) => Object.keys(f).filter((k) => k.startsWith(p)), read: (p) => f[p], size: (p) => f[p].length });
const transformed = (main = FIXTURE) => { const f = files(main); const { drafts } = deriveCuaSkillsTransform(source(f)); return applyAll(sealTransforms(drafts, (p) => f[p]), (p) => f[p]).get(MAIN); };

test('derives the one N1 transform: hash-chained, mandatory, the whole function applying exactly once with `return;` first', () => {
  const f = files();
  const { drafts, missing } = deriveCuaSkillsTransform(source(f));
  assert.deepEqual(missing, []);
  assert.deepEqual(drafts.map((d) => [d.id, d.file, d.op, d.find, d.text]), [[SKILLS_ID, MAIN, 'replace-once', FN, `async function Gne(e){return;${FN.slice('async function Gne(e){'.length)}`]]);
  const sealed = sealTransforms(drafts, (p) => f[p]);
  assert.deepEqual(mandatoryEditIds(sealed, []), [SKILLS_ID], 'a cua-* id: a mandatory edit');
  const out = applyAll(sealed, (p) => f[p]).get(MAIN);
  assert.ok(out.includes('async function Gne(e){return;let t=la(e)'));
  assert.throws(() => applyAll(sealed, (p) => f[p] + ' '), /sha256Before mismatch/);
});

// ---- behaviour of the stock and the transformed code: a fake fs records every access
function run(text, { installed = ['computer-use'] } = {}) {
  const calls = [];
  const fs = Object.fromEntries(['access', 'rm', 'cp', 'mkdir', 'rename'].map((op) => [op, async (...a) => { calls.push([op, a[0]]); }]));
  const deps = {
    i: { Bo: 'browser-use', Uo: 'chrome', Ho: 'chrome-2', Vo: 'chrome-3', qo: 'computer-use', Kt: ({ pluginName, localVersion }) => `/home/.codex/plugins/cache/openai-bundled/${pluginName}/${localVersion}` },
    la: () => [{ name: 'openai-bundled', plugins: [{ name: 'computer-use', installed: true, enabled: true, availability: 'AVAILABLE', localVersion: '1.0.0' }, { name: 'browser-use', installed: true, enabled: true, availability: 'AVAILABLE', localVersion: '2.0.0' }] }],
    S: { default: { join: (...p) => p.join('/'), dirname: (p) => p.split('/').slice(0, -1).join('/') } },
    b: { existsSync: (p) => { calls.push(['existsSync', p]); return installed.some((s) => p.includes(`/skills/${s}/`)); } },
    Ho: async ({ pluginName }) => { calls.push(['bundled', pluginName]); return { path: `/app/Resources/plugins/${pluginName}`, version: pluginName === 'computer-use' ? '1.0.0' : '9.9.9' }; },
    Pa: () => '/app/marketplace', k: fs, _: { randomUUID: () => 'uuid' }, ka: async () => true, Oa: () => {},
  };
  const names = Object.keys(deps);
  const { Gne, Ss } = new Function(...names, `${text}; return { Gne, Ss };`)(...names.map((n) => deps[n]));
  return { Gne, Ss, calls };
}

test('stock: the exposure removes or copies skills in the shared plugin cache (temp dir skill-<uuid>) and throws on a version mismatch; transformed: no filesystem access at all', async () => {
  // computer surface served by cua_repl: the installed computer-use skill is removed
  const stock = run(FIXTURE);
  await stock.Gne({ cuaReplSurfaces: ['computer', 'browser'], platform: 'darwin', codexHome: '/home/.codex' });
  assert.ok(stock.calls.some(([op, p]) => op === 'rm' && p === '/home/.codex/plugins/cache/openai-bundled/computer-use/1.0.0/skills/computer-use'), 'stock removes the skill');
  // no surface: the browser skill is exposed, but the bundled plugin version differs -> throws
  await assert.rejects(run(FIXTURE, { installed: [] }).Gne({ cuaReplSurfaces: [], platform: 'darwin', codexHome: '/home/.codex' }), new RegExp(MISMATCH));
  const expose = run(FIXTURE, { installed: [] });
  await expose.Gne({ cuaReplSurfaces: ['browser'], platform: 'darwin', codexHome: '/home/.codex' });
  assert.deepEqual(expose.calls.filter(([op]) => ['cp', 'rename'].includes(op)).map(([op, p]) => [op, p]),
    [['cp', '/app/Resources/plugins/computer-use/skills/computer-use'], ['rename', '/home/.codex/plugins/cache/openai-bundled/computer-use/1.0.0/.codex-plugin/skill-uuid']], 'stock copies through the temp dir');

  const out = transformed();
  for (const [surfaces, installed] of [[['computer'], ['computer-use']], [[], []], [['browser'], []], [['browser', 'computer'], ['computer-use', 'control-in-app-browser']]]) {
    const t = run(out, { installed });
    assert.equal(await t.Gne({ cuaReplSurfaces: surfaces, platform: 'darwin', codexHome: '/home/.codex' }), undefined);
    assert.deepEqual(t.calls, [], `no filesystem access (surfaces ${surfaces.join(',') || 'none'})`);
  }
  // the caller is unaffected: it awaited the exposure and discarded its value
  const t = run(out);
  assert.equal(await t.Ss({ hostConfig: { kind: 'local' } }, ['computer'], '/home/.codex', [], { platform: 'darwin' }), true);
  assert.deepEqual(t.calls, []);
});

test('exposedCuaSkills sees the stock exposure, nothing after the transform, and fails closed on a text without the anchors', () => {
  assert.deepEqual(exposedCuaSkills(FIXTURE), ['Gne() still copies or removes skills in the shared plugin cache']);
  assert.deepEqual(exposedCuaSkills(transformed()), []);
  assert.match(exposedCuaSkills('function x(){}').join(), /anchor not found.*fail closed/);
});

test('fails closed (mandatory miss, no drafts) when an anchor is absent, duplicated or drifted', () => {
  const cases = [
    ['error string renamed', FIXTURE.replace(MISMATCH, 'Bundled CUA skills version mismatch'), /2? main bundles|occurs 0 times|0 main bundles/],
    ['error string twice', `${FIXTURE}\nfunction z(){throw Error(\`${MISMATCH}: x\`)}`, /occurs 2 times/],
    ['a skill renamed in the map', FIXTURE.replace('`control-in-app-browser`', '`control-iab`'), /main bundles|skill directory map/],
    ['two skill maps', FIXTURE.replace(MAP, `${MAP}var Xne=${MAP.slice('var Wne='.length)}`), /skill directory map .* occurs 2 times/],
    ['the temp dir changed', FIXTURE.replace('`skill-${', '`tmp-skill-${'), /lacks `\x60skill-\$\{`/],
    ['the copy goes through another API', FIXTURE.replace('await(0,k.cp)(', 'await(0,k.copy)('), /lacks `\.cp\)\(`/],
    ['the error moved out of the function', FIXTURE.replace('throw Error(`Bundled CUA skill version mismatch: ${n.name}`)', 'throw Error(`version`)').replace('function hs(e){', `function hs(e){if(e)throw Error(\`${MISMATCH}\`);`), /lacks|does not enclose/],
    ['a caller uses the result', FIXTURE.replace('await Gne({', 'w=await Gne({'), /uses its result/],
    ['the function is passed around', `${FIXTURE}\nlet ref=Gne;`, /not an awaited call/],
  ];
  for (const [label, main, why] of cases) {
    const r = deriveCuaSkillsTransform(source(files(main)));
    assert.deepEqual(r.drafts, [], label);
    assert.equal(r.missing.length, 1, label);
    assert.equal(r.missing[0].item, `transform:${SKILLS_ID}`, label);
    assert.equal(r.missing[0].mandatory, true, label);
    assert.match(r.missing[0].tried, why, label);
  }
  // no main bundle at all
  assert.match(deriveCuaSkillsTransform(source({ '.vite/build/other.js': FIXTURE })).missing[0].tried, /0 main bundles/);
});

test('a second declaration of the same name is a miss, not a guess', () => {
  const r = deriveCuaSkillsTransform(source(files(`${FIXTURE}\nconst inner=()=>{async function Gne(e){let t=1;return t}};`)));
  assert.deepEqual(r.drafts, []);
  assert.match(r.missing[0].tried, /not an awaited call/);
});

test('matchClose skips strings and template literals with nested expressions', () => {
  const s = 'f(a,`x)${g({b:`}`})}y(`,"(",\'}\')+1';
  assert.equal(matchClose(s, 1), s.length - 2);
  assert.equal(matchClose('{a:`${', 0), -1);
  assert.equal(matchClose('(a]', 0), -1);
  const loc = locateSkillExposure(FIXTURE);
  assert.equal(FIXTURE.slice(loc.start, loc.end), FN);
  assert.deepEqual(usedResults(FIXTURE, loc), []);
});

// ---- the stock app (read only), on every build the pack tests cover
for (const { bundle, version } of [{ bundle: '20770', version: '26.1013.40934' }, { bundle: '21477', version: '26.1016.62342' }]) {
  const stock = locateStock({ bundleVersion: bundle, version })?.source ?? null;
  const noStock = stock ? false : `stock ChatGPT ${version} (${bundle}) not available`;

  test(`stock ${bundle}: derives the one N1 edit in the main bundle; after it the exposure returns first and no other script exposes skills`, { skip: noStock }, () => {
    const { drafts, missing } = deriveCuaSkillsTransform(stock);
    assert.deepEqual(missing, []);
    assert.equal(drafts.length, 1);
    const [d] = drafts;
    assert.match(d.file, /^\.vite\/build\/main-[^/]+\.js$/);
    const head = /^async function [\w$]+\([\w$]+\)\{/.exec(d.find)[0];
    assert.ok(d.find.includes(MISMATCH) && d.find.endsWith('}'), 'the find is the whole function');
    assert.deepEqual([d.id, d.op, d.text], [SKILLS_ID, 'replace-once', `${head}return;${d.find.slice(head.length)}`]);
    const text = stock.read(d.file);
    assert.equal(text.split(d.find).length - 1, 1);
    assert.equal(exposedCuaSkills(text).length, 1);
    const out = applyAll(sealTransforms(drafts, (p) => stock.read(p)), (p) => stock.read(p)).get(d.file);
    assert.deepEqual(exposedCuaSkills(out), []);
    for (const f of stock.list('').filter((p) => /\.(m?js|cjs)$/.test(p) && !p.startsWith('webview/') && p !== d.file)) {
      assert.ok(!stock.read(f).includes(MISMATCH), `${f} names the skill exposure`);
    }
  });

  test(`stock ${bundle}: a drifted anchor fails loudly (mandatory miss naming it), never a silent pass`, { skip: noStock }, () => {
    const drift = (from, to) => ({ list: (p) => stock.list(p), size: (p) => stock.size(p), read: (p) => { const t = stock.read(p); return p.startsWith('.vite/build/main-') ? t.replaceAll(from, to) : t; } });
    // the entry of the map that names the Computer Use skill directory, as the build spells its key (`[i.qo]:`computer-use`}` on 20770)
    const key = /\[[\w$.]+\]:`computer-use`\}/.exec(stock.list('.vite/build/main-').map((f) => stock.read(f)).join('\n'))?.[0];
    assert.ok(key, 'the skill directory map has its Computer Use entry');
    for (const [from, to, why] of [
      [MISMATCH, 'Bundled CUA skill version differs', /0 main bundles/],
      ['`.codex-plugin`,`skill-${', '`.codex-plugin`,`skills-tmp-${', /lacks/],
      [key, key.replace('computer-use', 'computer-usf'), /skill directory map .* occurs 0 times/],
    ]) {
      const r = deriveCuaSkillsTransform(drift(from, to));
      assert.deepEqual(r.drafts, [], from);
      assert.equal(r.missing[0]?.item, `transform:${SKILLS_ID}`, from);
      assert.match(r.missing[0].tried, why, from);
    }
  });
}
