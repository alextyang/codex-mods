// the managed tool sync must not persist the copy's node_repl / cua_repl configuration into shared state. Synthetic fixtures (no stock app needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveManagedConfigTransforms, persistedManagedConfig, CUA_REPL_STASH } from './managed-config.mjs';
import { sealTransforms, applyAll } from './transform.mjs';
import { mandatoryEditIds, checkConfigOverrides, OVERRIDE_VARIABLES } from './generate-adapter.mjs';

const MAIN = '.vite/build/main-X.js';
// shapes copied from the 20156 main bundle (identifiers as minified there)
const FIXTURE = [
  'var Ia={[`mcp_servers.${r.rs}`]:{command:process.execPath,enabled:!1}};',
  'async function rne(e){let t=wa(1);if(!t?.plugin.installed)return!1;let n=e.nodeRepl!=null&&e.surfaces.length>0,i=r.Gt(1),a=C.default.join(i,`.mcp.json`),o=await(0,x.readFile)(a,`utf8`),s=nne.parse(JSON.parse(o)),c=s.mcpServers.cua_repl,l={};e.surfaces.includes(`computer`)&&(l.sky=`@oai/sky/service`),c.enabled=n,c.env={...e.nodeRepl?.env,[r.us]:JSON.stringify(l)},e.nodeRepl!=null&&(c.command=e.nodeRepl.command);let u=`${JSON.stringify(s,null,2)}\\n`;if(u!==o){let e=`${a}.tmp-${(0,R.randomUUID)()}`;await(0,x.writeFile)(e,u),await(0,x.rename)(e,a)}return n}',
  'async function hc({appServerConnection:e,reloadUserConfig:s=!0}){let C=await ic(e),w=await rne({nodeRepl:C?.[`mcp_servers.node_repl`],surfaces:[`browser`,`computer`]});let T=[...gc(C),{keyPath:`mcp_servers.${r.rs}`,mergeStrategy:`replace`,value:w?null:Ia[`mcp_servers.${r.rs}`]}];return await e.sendAppServerRequest(`config/batchWrite`,{edits:T,expectedVersion:null,filePath:null,reloadUserConfig:s}),{selection:1,cuaReplEnabled:w}}',
  'function gc(e){return[{keyPath:`mcp_servers.${r.ss}`,mergeStrategy:`replace`,value:e?.[`mcp_servers.node_repl`]??null},...cc.map(e=>({keyPath:`shell_environment_policy.set.${e}`,mergeStrategy:`replace`,value:null}))]}',
  'async function _c(e){let{appServerConnection:t}=e,r=await fc(t),a=r,o=a.selection,s=await ic({...e,selection:o});return!a?.cuaReplEnabled||s?.[`mcp_servers.node_repl`]==null?{...s,...Ia}:(La(s[`mcp_servers.node_repl`],o.cuaReplSurfaces),s)}',
  'class Y{gc(e){}write(e,t){}}',        // unrelated `gc` method (a CRDT library in the real bundle)
].join('\n');
const files = (main = FIXTURE) => ({ [MAIN]: main });
const source = (f) => ({ list: (p) => Object.keys(f).filter((k) => k.startsWith(p)), read: (p) => f[p], size: (p) => f[p].length });
const IDS = ['managed-config-no-persist', 'managed-config-no-persist-cua-repl', 'managed-config-cua-repl-thread'];

test('derives the three managed-config transforms, hash-chained, and they apply exactly once', () => {
  const f = files();
  const { drafts, missing } = deriveManagedConfigTransforms(source(f));
  assert.deepEqual(missing, []);
  assert.deepEqual(drafts.map((d) => d.id), IDS);
  const sealed = sealTransforms(drafts, (p) => f[p]);
  const out = applyAll(sealed, (p) => f[p]).get(MAIN);
  assert.ok(out.includes('let T=gc(C).slice(1);return await e.sendAppServerRequest'));
  assert.deepEqual(mandatoryEditIds(sealed, []), IDS, 'all three are mandatory edits');
  assert.throws(() => applyAll(sealed, (p) => f[p] + ' '), /sha256Before mismatch/);
});

// ---- behaviour of the transformed code
function run(out, { nodeRepl = { command: '/copy/node_repl', env: { CODEX_CLI_PATH: '/copy/relay' } }, readJson } = {}) {
  const calls = { requests: [], writes: [], renames: [] };
  const r = { rs: 'cua_repl', ss: 'node_repl', us: 'NODE_REPL_TRUSTED_SERVICES', Gt: () => '/home/.codex/plugins/cache/p' };
  const mcpJson = readJson ?? JSON.stringify({ mcpServers: { cua_repl: { command: 'stock-node', args: ['/stock/cua-repl.mjs'], enabled: true, env: { CODEX_CLI_PATH: '/stock/relay' } } } });
  const x = { readFile: async () => mcpJson, writeFile: async (...a) => { calls.writes.push(a); }, rename: async (...a) => { calls.renames.push(a); } };
  const deps = { r, x, C: { default: { join: (...p) => p.join('/') } }, R: { randomUUID: () => 'u' }, wa: () => ({ plugin: { installed: true } }), nne: { parse: (v) => v },
    cc: ['NODE_REPL_BROWSER_BACKENDS', 'NODE_REPL_TRUSTED_CODE_PATHS'], Ia: undefined, ic: async () => (nodeRepl ? { 'mcp_servers.node_repl': nodeRepl } : null),
    fc: async () => ({ selection: { cuaReplSurfaces: ['browser'] }, cuaReplEnabled: true }), La: () => {} };
  const names = Object.keys(deps);
  const mk = new Function(...names, `${out}; return { hc, rne, _c, Ia };`);
  const fns = mk(...names.map((n) => deps[n]));
  return { ...fns, calls, deps };
}
const transformed = () => { const f = files(); const { drafts } = deriveManagedConfigTransforms(source(f)); return applyAll(sealTransforms(drafts, (p) => f[p]), (p) => f[p]).get(MAIN); };

test('stock hc writes node_repl and cua_repl into the shared config; the transformed hc sends only the shell_environment_policy deletions', async () => {
  delete globalThis.__codexmodsCuaRepl;
  for (const [label, text, expectKeys] of [['stock', FIXTURE, ['mcp_servers.node_repl', 'shell_environment_policy.set.NODE_REPL_BROWSER_BACKENDS', 'shell_environment_policy.set.NODE_REPL_TRUSTED_CODE_PATHS', 'mcp_servers.cua_repl']], ['patched', transformed(), ['shell_environment_policy.set.NODE_REPL_BROWSER_BACKENDS', 'shell_environment_policy.set.NODE_REPL_TRUSTED_CODE_PATHS']]]) {
    const { hc, calls, deps } = run(text);
    // hc needs a connection: reuse the spy
    await hc({ appServerConnection: { sendAppServerRequest: async (m, p) => { calls.requests.push([m, p]); } }, reloadUserConfig: false });
    void deps;
    const [m, p] = calls.requests.at(-1);
    assert.equal(m, 'config/batchWrite', label);
    assert.deepEqual(p.edits.map((e) => e.keyPath), expectKeys, label);
    assert.ok(p.edits.filter((e) => e.keyPath.startsWith('shell_environment_policy.')).every((e) => e.value === null), 'deletions are kept');
    assert.equal(p.reloadUserConfig, false);
  }
  delete globalThis.__codexmodsCuaRepl;
});

test('stock rne rewrites the shared plugin .mcp.json; the transformed rne writes nothing, keeps the definition in memory, and returns the same boolean', async () => {
  delete globalThis.__codexmodsCuaRepl;
  const stock = run(FIXTURE);
  assert.equal(await stock.rne({ nodeRepl: { command: '/copy/node_repl', env: {} }, surfaces: ['browser'] }), true);
  assert.equal(stock.calls.writes.length, 1, 'stock persists');
  assert.equal(stock.calls.renames.length, 1);

  const t = run(transformed());
  assert.equal(await t.rne({ nodeRepl: { command: '/copy/node_repl', env: { A: '1' } }, surfaces: ['browser', 'computer'] }), true);
  assert.deepEqual([t.calls.writes, t.calls.renames], [[], []], 'nothing is written to the shared plugin cache');
  const def = globalThis.__codexmodsCuaRepl;
  assert.equal(def.enabled, true);
  assert.equal(def.command, '/copy/node_repl');
  assert.equal(def.env.A, '1');
  assert.deepEqual(JSON.parse(def.env.NODE_REPL_TRUSTED_SERVICES), { sky: '@oai/sky/service' });
  assert.deepEqual(def.args, ['/stock/cua-repl.mjs'], 'the plugin template fields are kept');
  // not enabled (no surfaces): no definition handed on
  assert.equal(await t.rne({ nodeRepl: undefined, surfaces: [] }), false);
  assert.equal(globalThis.__codexmodsCuaRepl, null);
  delete globalThis.__codexmodsCuaRepl;
});

test('the per-thread config carries the cua_repl definition when cua_repl is enabled, and the disabled stub otherwise', async () => {
  delete globalThis.__codexmodsCuaRepl;
  const text = transformed();
  const { _c, deps } = run(text);
  const IaStub = { 'mcp_servers.cua_repl': { command: 'electron', enabled: false } };
  const mk = (over = {}) => new Function(...Object.keys(deps), 'Ia', `${text.replace(/var Ia=[^\n]*\n/, '')}; return _c;`)(...Object.keys(deps).map((k) => over[k] ?? deps[k]), IaStub);
  // without a stashed definition: unchanged (node_repl only)
  let cfg = await mk()({ appServerConnection: 1 });
  assert.deepEqual(Object.keys(cfg), ['mcp_servers.node_repl']);
  globalThis[CUA_REPL_STASH.split('.')[1]] = { command: '/copy/node_repl', enabled: true, env: { E: '1' } };
  cfg = await mk()({ appServerConnection: 1 });
  assert.deepEqual(Object.keys(cfg), ['mcp_servers.node_repl', 'mcp_servers.cua_repl']);
  assert.equal(cfg['mcp_servers.cua_repl'].command, '/copy/node_repl');
  // cua_repl disabled: the app's own disabled stub wins and the stashed definition is not used
  cfg = await mk({ fc: async () => ({ selection: { cuaReplSurfaces: [] }, cuaReplEnabled: false }) })({ appServerConnection: 1 });
  assert.deepEqual(cfg['mcp_servers.cua_repl'], { command: 'electron', enabled: false });
  delete globalThis.__codexmodsCuaRepl;
});

test('persistedManagedConfig finds the stock writes (three sites) and nothing after the transforms; unrelated gc methods do not count', () => {
  assert.equal(persistedManagedConfig(FIXTURE).length, 3, 'node_repl edit via gc(), the cua_repl edit, the plugin file write');
  assert.deepEqual(persistedManagedConfig(transformed()), []);
  assert.ok(persistedManagedConfig(transformed() + ';var q=[...gc(C)];').some((x) => /without dropping/.test(x)));
});

test('fails closed (mandatory miss, no drafts) when a site is absent, duplicated or its shape changed', () => {
  const cases = {
    'no gc': (t) => t.replace(/function gc\(e\)\{[^\n]*\n/, '\n'),
    'gc without the deletions': (t) => t.replace(',...cc.map(e=>({keyPath:`shell_environment_policy.set.${e}`,mergeStrategy:`replace`,value:null}))', ''),
    'no managed sync': (t) => t.replace('config/batchWrite', 'config/other'),
    'managed sync twice': (t) => t + '\n' + t.split('\n')[2].replace('hc(', 'hc2('),
    'rne write changed': (t) => t.replace('await(0,x.writeFile)(e,u),', 'await(0,x.writeFile)(e,u,1),'),
    'no rne': (t) => t.replace('c=s.mcpServers.cua_repl', 'c=s.mcpServers.other'),
    'per-thread assembly changed': (t) => t.replace('(La(s[`mcp_servers.node_repl`],o.cuaReplSurfaces),s)', '(s)'),
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const r = deriveManagedConfigTransforms(source(files(mutate(FIXTURE))));
    assert.deepEqual(r.drafts, [], name);
    assert.ok(r.missing.length === 1 && r.missing[0].mandatory === true && r.missing[0].item === 'transform:managed-config-no-persist', name);
  }
  assert.equal(deriveManagedConfigTransforms({ list: () => [], read: () => '' }).drafts.length, 0);
});

test('checkConfigOverrides: the required keys, TOML-shaped values and known template variables', () => {
  const ok = { notify: ['${computerUseDir}/x', 'turn-ended'], 'mcp_servers.node_repl': { command: '${resources}/cua_node/bin/node_repl', args: [], startup_timeout_sec: 120, env: { A: '${codexHome}:${relayPath}' } } };
  assert.deepEqual(checkConfigOverrides(ok), []);
  assert.deepEqual(OVERRIDE_VARIABLES, ['appContents', 'resources', 'computerUseDir', 'codexHome', 'relayPath', 'profileDir']);
  assert.match(checkConfigOverrides(undefined)[0], /missing/);
  assert.ok(checkConfigOverrides({ notify: [] }).some((p) => /mcp_servers\.node_repl/.test(p)));
  assert.ok(checkConfigOverrides({ ...ok, notify: ['${nope}'] }).some((p) => /unknown template variable/.test(p)));
  assert.ok(checkConfigOverrides({ ...ok, 'bad key!': 1 }).some((p) => /dotted config path/.test(p)));
  assert.ok(checkConfigOverrides({ ...ok, x: null }).some((p) => /TOML-shaped/.test(p)));
});

// ---- the 20770 shapes (identifiers as minified there): other property names, the statement form of the plugin rewrite, and a per-thread assembly
// in which the app already sets cua_repl itself when the cached principal id exists
const MAIN70 = '.vite/build/main-CLu1A25j.js';
const FIXTURE70 = [
  'var Ea={[`mcp_servers.${i.as}`]:{command:process.execPath,enabled:!1}};',
  'async function ka(e){let t=Ta(1);if(!t?.plugin.installed)return!1;let n=e.nodeRepl!=null&&e.surfaces.length>0,r=i.Kt(1),a=S.default.join(r,`.mcp.json`),o=await(0,k.readFile)(a,`utf8`),s=Da.parse(JSON.parse(o)),c=s.mcpServers.cua_repl;Object.assign(c,Aa(e));let l=`${JSON.stringify(s,null,2)}\\n`;if(l!==o){let e=`${a}.tmp-${(0,_.randomUUID)()}`;await(0,k.writeFile)(e,l),await(0,k.rename)(e,a)}return n}',
  'async function Ure({appServerConnection:e,reloadUserConfig:s=!0}){let C=await Hs(e),w=await ka({nodeRepl:C?.[`mcp_servers.node_repl`],surfaces:[`browser`,`computer`]});let T=[...Wre(C),{keyPath:`mcp_servers.${i.as}`,mergeStrategy:`replace`,value:w?null:Ea[`mcp_servers.${i.as}`]}];return await e.sendAppServerRequest(`config/batchWrite`,{edits:T,expectedVersion:null,filePath:null,reloadUserConfig:s}),{selection:1,cuaReplEnabled:w}}',
  'function Wre(e){return[{keyPath:`mcp_servers.${i.ls}`,mergeStrategy:`replace`,value:e?.[`mcp_servers.node_repl`]??null},...Vre.map(e=>({keyPath:`shell_environment_policy.set.${e}`,mergeStrategy:`replace`,value:null}))]}',
  'async function Zs(o,c,u,l,s){return l!=null&&u!=null&&Object.assign(l.env,{K:u}),!o?.cuaReplEnabled||c?.[`mcp_servers.node_repl`]==null?{...c,...Ea}:(u!=null&&l!=null&&(c[`mcp_servers.${i.as}`]=Aa({browserBackends:s.browserBackends,deferTools:s.desktopFeatureAvailability.deferCuaTools,surfaces:s.cuaReplSurfaces,nodeRepl:l})),Oa(c[`mcp_servers.node_repl`],s.cuaReplSurfaces),c)}',
  'class Y{Wre(e){}write(e,t){}}',        // an unrelated method of the same name
].join('\n');
const derive70 = (text = FIXTURE70) => { const f = { [MAIN70]: text }; return { f, ...deriveManagedConfigTransforms(source(f)) }; };
const patched70 = () => { const { f, drafts } = derive70(); return applyAll(sealTransforms(drafts, (p) => f[p]), (p) => f[p]).get(MAIN70); };

test('20770 shapes: the three transforms derive with wildcarded property names and the statement form, hash-chained, applying exactly once', () => {
  const { f, drafts, missing } = derive70();
  assert.deepEqual(missing, []);
  assert.deepEqual(drafts.map((d) => d.id), IDS);
  assert.equal(drafts[0].find, 'let T=[...Wre(C),{keyPath:`mcp_servers.${i.as}`,mergeStrategy:`replace`,value:w?null:Ea[`mcp_servers.${i.as}`]}]');
  assert.equal(drafts[0].text, 'let T=Wre(C).slice(1)');
  assert.equal(drafts[1].text, `return ${CUA_REPL_STASH}=n?structuredClone(c):null,n}`);
  assert.equal(drafts[1].find, 'let l=`${JSON.stringify(s,null,2)}\\n`;if(l!==o){let e=`${a}.tmp-${(0,_.randomUUID)()}`;await(0,k.writeFile)(e,l),await(0,k.rename)(e,a)}return n}', 'only the write tail; the app\'s own declarations stay');
  assert.equal(drafts[2].find, 'u!=null&&l!=null&&(c[`mcp_servers.${i.as}`]=Aa({browserBackends:s.browserBackends,deferTools:s.desktopFeatureAvailability.deferCuaTools,surfaces:s.cuaReplSurfaces,nodeRepl:l}))');
  assert.equal(drafts[2].text, `u!=null&&l!=null?c[\`mcp_servers.\${i.as}\`]=Aa({browserBackends:s.browserBackends,deferTools:s.desktopFeatureAvailability.deferCuaTools,surfaces:s.cuaReplSurfaces,nodeRepl:l}):${CUA_REPL_STASH}!=null&&(c[\`mcp_servers.\${i.as}\`]=structuredClone(${CUA_REPL_STASH}))`);
  const sealed = sealTransforms(drafts, (p) => f[p]);
  assert.deepEqual(mandatoryEditIds(sealed, []), IDS);
  assert.throws(() => applyAll(sealed, (p) => f[p] + ' '), /sha256Before mismatch/);
  assert.equal(persistedManagedConfig(FIXTURE70).length, 3, 'the checker sees the three stock writes of this shape');
  assert.deepEqual(persistedManagedConfig(patched70()), []);
  new Function(`${patched70().replace(/^var Ea=.*$/m, 'var Ea={};')}; return 1;`);              // the patched text still parses
});

test('20770 option (a): the app\'s native per-thread cua_repl is kept when the principal id exists; the stash is only the fallback', async () => {
  const out = patched70();
  const make = () => new Function('i', 'Aa', 'Oa', 'Ea', `${out.slice(out.indexOf('async function Zs'), out.indexOf('class Y'))}; return Zs;`)(
    { as: 'cua_repl' }, (a) => ({ native: true, nodeRepl: a.nodeRepl.command }), () => {}, { 'mcp_servers.cua_repl': { command: 'electron', enabled: false } });
  const Zs = make();
  const s = { browserBackends: [], desktopFeatureAvailability: { deferCuaTools: false }, cuaReplSurfaces: ['browser'] };
  const cfg = () => ({ 'mcp_servers.node_repl': { command: '/copy/node_repl' } });
  const l = () => ({ command: '/copy/per-thread-node_repl', env: {} });
  delete globalThis.__codexmodsCuaRepl;
  // principal id exists: the native (richer) definition, even when a stash exists
  globalThis.__codexmodsCuaRepl = { stash: true };
  assert.deepEqual((await Zs({ cuaReplEnabled: true }, cfg(), 'principal', l(), s))['mcp_servers.cua_repl'], { native: true, nodeRepl: '/copy/per-thread-node_repl' });
  // no principal id: the stash (a copy, so the thread config cannot change it)
  const withStash = await Zs({ cuaReplEnabled: true }, cfg(), null, l(), s);
  assert.deepEqual(withStash['mcp_servers.cua_repl'], { stash: true });
  assert.notEqual(withStash['mcp_servers.cua_repl'], globalThis.__codexmodsCuaRepl);
  // no principal id and no stash: nothing is set (the app's behaviour)
  globalThis.__codexmodsCuaRepl = null;
  assert.ok(!('mcp_servers.cua_repl' in await Zs({ cuaReplEnabled: true }, cfg(), null, l(), s)));
  // cua_repl not enabled: the app's disabled stub, the stash is not used
  globalThis.__codexmodsCuaRepl = { stash: true };
  assert.deepEqual((await Zs({ cuaReplEnabled: false }, cfg(), null, l(), s))['mcp_servers.cua_repl'], { command: 'electron', enabled: false });
  delete globalThis.__codexmodsCuaRepl;
});

test('20770 shapes fail closed (mandatory miss, no drafts) when a site is absent, duplicated or its shape changed', () => {
  const cases = {
    'no builder': (t) => t.replace(/function Wre\(e\)\{[^\n]*\n/, '\n'),
    'builder without the deletions': (t) => t.replace(',...Vre.map(e=>({keyPath:`shell_environment_policy.set.${e}`,mergeStrategy:`replace`,value:null}))', ''),
    'no managed sync': (t) => t.replace('config/batchWrite', 'config/other'),
    'managed sync twice': (t) => t + '\n' + t.split('\n')[2].replace('Ure(', 'Ure2('),
    'the sync writes the node_repl key twice': (t) => t.replace('{keyPath:`mcp_servers.${i.as}`,mergeStrategy:`replace`,value:w?null:Ea[`mcp_servers.${i.as}`]}', '{keyPath:`mcp_servers.${i.ls}`,mergeStrategy:`replace`,value:w?null:Ea[`mcp_servers.${i.ls}`]}'),
    'plugin write changed': (t) => t.replace('await(0,k.writeFile)(e,l),', 'await(0,k.writeFile)(e,l,1),'),
    'no plugin rewrite': (t) => t.replace('c=s.mcpServers.cua_repl;', 'c=s.mcpServers.other;'),
    'plugin rewrite twice': (t) => t + '\n' + t.split('\n')[1].replace('ka(', 'ka2('),
    'per-thread native assignment changed': (t) => t.replace('deferTools:s.desktopFeatureAvailability.deferCuaTools', 'deferTools:!1'),
    'per-thread assembly changed': (t) => t.replace(',Oa(c[`mcp_servers.node_repl`],s.cuaReplSurfaces),c)', ',c)'),
    'per-thread assembly twice': (t) => t + '\n' + t.split('\n')[4].replace('Zs(', 'Zs2('),
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const r = derive70(mutate(FIXTURE70));
    assert.deepEqual(r.drafts, [], name);
    assert.ok(r.missing.length === 1 && r.missing[0].mandatory === true && r.missing[0].item === 'transform:managed-config-no-persist', name);
  }
});

test('the main bundle is found by role: a renamed bundle derives the same edits, and two candidates are a miss', () => {
  const a = derive70();
  const renamed = deriveManagedConfigTransforms(source({ '.vite/build/main-ZzZzZzZz.js': FIXTURE70 }));
  assert.deepEqual(renamed.drafts.map((d) => [d.id, d.find, d.text]), a.drafts.map((d) => [d.id, d.find, d.text]));
  const two = deriveManagedConfigTransforms(source({ [MAIN70]: FIXTURE70, '.vite/build/main-Other123.js': FIXTURE70 }));
  assert.deepEqual(two.drafts, []); assert.match(two.missing[0].tried, /2 main bundles/);
  assert.deepEqual(deriveManagedConfigTransforms(source({ '.vite/build/worker.js': FIXTURE70 })).drafts, [], 'not a main bundle');
});

test('persistedManagedConfig fails closed: a text without the anchors (a bundle it does not apply to) is reported, never silently clean', () => {
  const r = persistedManagedConfig('function f(){return 1}');
  assert.equal(r.length, 2);
  assert.ok(r.every((x) => /anchor not found/.test(x)));
});

test('persistedManagedConfig bounds the rewrite by the parser\'s function: a `}` in a regular expression, or a write split off before the writer, is still seen (review 2026-11-07)', () => {
  const tail = 'Object.assign(o,rN({...e}));return globalThis.__codexmodsCuaRepl=r?structuredClone(o):null,r}';
  const head = 'async function W(e){let n=e.dir,i=ee().join(n,".mcp.json"),s=await (0,eb.readFile)(i,"utf8"),a=JSON.parse(s),o=a.mcpServers.cua_repl,l=1;';
  const anchors = 'let T=[{keyPath:`shell_environment_policy.set.${e}`}];';
  assert.deepEqual(persistedManagedConfig(`${anchors}${head}${tail}`).filter((f) => /written to the shared plugin/.test(f)), []);
  // a regular expression holding `}` before a write: a bracket count would end the function there
  assert.equal(persistedManagedConfig(`${anchors}${head}/}/.test(s);await (0,eb.writeFile)(i,JSON.stringify(a));${tail}`).filter((f) => /written to the shared plugin/.test(f)).length, 1);
});
