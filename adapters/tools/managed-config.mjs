// the copy must not persist its own managed tool configuration into state shared with the stock app.
//
// Upstream's "managed tool sync" (run at every bundled-plugin reconcile: launch, desktop-feature change, plugin install/uninstall) writes
//  (a) `config/batchWrite` edits `mcp_servers.node_repl` (command, args, env with the app's own node_repl/relay/helper paths) and `mcp_servers.cua_repl`
//      into the shared <CODEX_HOME>/config.toml, and
//  (b) rewrites the cua-repl plugin's `.mcp.json` in the shared plugin cache (<CODEX_HOME>/plugins/cache/openai-bundled/…/.mcp.json) with the
//      app's own command, args and env.
// The same values already reach the app-server per thread (thread/start `config`) for node_repl. For the plugin-supplied `cua_repl` they did not in
// 20156 (its definition lived only in the plugin file); from 20770 on the app sends the full `cua_repl` table per thread itself whenever the cached
// principal id exists. Experiment (UID503, bundled codex 0.162): a top-level `mcp_servers.cua_repl=<full table>` override REPLACES the plugin-supplied
// definition entirely (a partial table is an invalid transport); a plugin-namespaced key does not.
//
// Edits (all mandatory, hash-checked, fail closed; minified names are captured from the bundle, never assumed):
//  - `managed-config-no-persist`          the tool sync sends only the `shell_environment_policy` deletions (`F(C).slice(1)`): no `mcp_servers.node_repl` / `mcp_servers.cua_repl` edit.
//  - `managed-config-no-persist-cua-repl` the plugin rewrite computes the same definition but does not write the plugin `.mcp.json`; it keeps the definition in memory (globalThis.__codexmodsCuaRepl).
//  - `managed-config-cua-repl-thread`     the per-thread config carries that definition as `mcp_servers.cua_repl` (full, dynamic: surfaces, env, enabled tools): on a build whose app already
//                                          assigns it per thread, the app's native assignment is kept and the stash is only the fallback when the app does not assign it.
// The static baseline (notify, node_repl) for the app-server's own process is declared in the pack as `backend.configOverrides` (the Host adds `-c` args).
import { applyOp, findMainBundle } from './transform.mjs';

const ID = '[A-Za-z_$][\\w$]*';
const esc = (s) => s.replaceAll('$', '\\$');
const Q = '[`"\']';   // a string literal's quote: 21477 writes template literals, 22943 quoted strings
export const MANAGED_PREFIX = 'managed-config-';
export const CUA_REPL_STASH = 'globalThis.__codexmodsCuaRepl';

/**
 * Findings of managed configuration that is still persisted to shared state: a `gc(...)` call that is not `.slice(1)`d (its first edit is the
 * `mcp_servers.node_repl` write), a `mcp_servers.<rs>` keyPath edit in a batchWrite edit list, and a write in `rne`.
 */
export function persistedManagedConfig(text) {
  // Located by shape and string anchors, never by minified names, so a new build cannot make the check pass vacuously: a missing anchor
  // is itself a finding (fail closed).
  const out = [];
  const builder = new RegExp(`function (${ID})\\((${ID})\\)\\{return\\[\\{keyPath:\`mcp_servers\\.\\$\\{${ID}\\.${ID}\\}\`,mergeStrategy:\`replace\`,value:\\2\\?\\.\\[\`mcp_servers\\.node_repl\`\\]`).exec(text);
  if (!builder) {
    // 22943 builds the edit list inline in the tool sync: the shell_environment_policy deletions must be there (fail closed), and no
    // `mcp_servers.${…}` keyPath edit may be left anywhere
    if (!/keyPath:`shell_environment_policy\.set\.\$\{/.test(text)) out.push('anchor not found: the managed node_repl edit list, by function or inline (fail closed)');
    else for (const m of text.matchAll(new RegExp(`keyPath:\`mcp_servers\\.\\$\\{(${ID})\\.(${ID})\\}\``, 'g'))) out.push(`a batchWrite edit still writes ${m[0]}`);
  } else {
    const gc = builder[1];
    const esc = gc.replace(/\$/g, '\\$');
    for (const m of text.matchAll(new RegExp(`(?<![\\w$])${esc}\\(`, 'g'))) {
      if (text.slice(Math.max(0, m.index - 3), m.index) !== '...') continue;    // only the spread of its edits into a batchWrite list (unrelated methods may share the name)
      const call = text.slice(m.index, m.index + 40);
      if (!new RegExp(`^${esc}\\(${ID}\\)\\.slice\\(1\\)`).test(call)) out.push(`${gc}() is spread into a batchWrite without dropping the node_repl edit: ...${call}`);
    }
    for (const m of text.matchAll(new RegExp(`keyPath:\`mcp_servers\\.\\$\\{(${ID})\\.(${ID})\\}\``, 'g'))) {
      const before = text.slice(Math.max(0, m.index - 60), m.index);
      if (!new RegExp(`function ${esc}\\(${ID}\\)\\{return\\[\\{$`).test(before)) out.push(`a batchWrite edit still writes ${m[0]}`);
    }
  }
  const writer = new RegExp(`(?<![\\w$])${ID}=${ID}\\.mcpServers\\.cua_repl[,;]`).exec(text);
  const repl = writer ? writer.index : -1;
  if (repl < 0) out.push('anchor not found: the cua_repl plugin definition writer (fail closed)');
  else {
    const tail = text.slice(repl, repl + 2400);
    const end = tail.search(/return [\w$]+\}/);
    if (/writeFile|\.rename\)|\.rename\(/.test(end < 0 ? tail : tail.slice(0, end))) out.push('the cua_repl plugin definition is still written to the shared plugin .mcp.json');
  }
  return out;
}

/**
 * @param {{ list(prefix: string): string[], read(p: string): string }} source
 * @returns {{ drafts: object[], missing: object[] }} drafts for the three managed-config transforms (applied on the main bundle)
 *
 * Everything is located by string anchors and structure; minified names are captured, never assumed (the config constants' property names differ per
 * build: `.ss`/`.rs` in 20156, `.ls`/`.as` in 20770). Shapes understood (20156 and 20770):
 *  - the edit list builder: `function F(e){return[{keyPath:`mcp_servers.${X.p}`,…,value:e?.[`mcp_servers.node_repl`]??null},...D.map(…shell_environment_policy…)]}`;
 *  - the tool sync spreads it into one `config/batchWrite` list next to the `cua_repl` edit (`mcp_servers.${X.q}`);
 *  - the plugin `.mcp.json` rewrite reaches `mcpServers.cua_repl` by a `,` chain (20156) or a `;` statement (20770);
 *  - the per-thread assembly either never sets `cua_repl` itself (20156: the transform adds the stash), or sets it from the cached principal when that exists
 *    (20770: the app's richer native definition is kept; the stash is only the fallback for the other case. Owner decision, option a).
 */
export function deriveManagedConfigTransforms(source) {
  const miss = (tried) => ({ drafts: [], missing: [{ item: 'transform:managed-config-no-persist', mandatory: true, tried }] });
  const found = findMainBundle(source, ['config/batchWrite', 'mcp_servers.node_repl', 'mcpServers.cua_repl', 'cuaReplEnabled']);
  if (found.error) return miss(found.error);
  const { file, text } = found;
  const drafts = [];

  // F(): [mcp_servers.node_repl edit, ...shell_environment_policy deletions]
  const gcRe = new RegExp(`function (${ID})\\((${ID})\\)\\{return\\[\\{keyPath:\`mcp_servers\\.\\$\\{(${ID})\\.(${ID})\\}\`,mergeStrategy:\`replace\`,value:\\2\\?\\.\\[\`mcp_servers\\.node_repl\`\\]\\?\\?null\\},\\.\\.\\.(${ID})\\.map\\(\\(?(${ID})\\)?=>\\(\\{keyPath:\`shell_environment_policy\\.set\\.\\$\\{\\6\\}\`,mergeStrategy:\`replace\`,value:null\\}\\)\\)\\]\\}`, 'g');
  const gcs = [...text.matchAll(gcRe)];
  // 22943 inlines the builder into the tool sync: `let T=[...(h=C,[{node_repl edit},...D.map(deletion)]),{cua_repl edit}];return await X.sendAppServerRequest("config/batchWrite",{edits:T,`
  const inlineRe = new RegExp(`let (${ID})=\\[\\.\\.\\.\\((${ID})=(${ID}),\\[\\{keyPath:\`mcp_servers\\.\\$\\{(${ID})\\.(${ID})\\}\`,mergeStrategy:${Q}replace${Q},value:\\2\\?\\.\\[\`mcp_servers\\.\\$\\{\\4\\.\\5\\}\`\\]\\?\\?null\\},\\.\\.\\.((${ID})\\.map\\(\\(?(${ID})\\)?=>\\(\\{keyPath:\`shell_environment_policy\\.set\\.\\$\\{\\8\\}\`,mergeStrategy:${Q}replace${Q},value:null\\}\\)\\))\\]\\),\\{keyPath:\`mcp_servers\\.\\$\\{\\4\\.(${ID})\\}\`,mergeStrategy:${Q}replace${Q},value:(${ID})\\?null:(${ID})\\[\`mcp_servers\\.\\$\\{\\4\\.\\9\\}\`\\]\\}\\];return await (${ID})\\.sendAppServerRequest\\(${Q}config/batchWrite${Q},\\{edits:\\1,`, 'g');
  const inlines = gcs.length ? [] : [...text.matchAll(inlineRe)];
  if (gcs.length !== 1 && inlines.length !== 1) return miss(`the managed edit list (node_repl write + shell_environment_policy deletions) occurs ${gcs.length} times by function and ${inlines.length} times inline (expected exactly 1)`);
  const noPersistWhy = 'D-M5-1: the managed tool sync must not persist mcp_servers.node_repl / mcp_servers.cua_repl (the copy\'s own paths) into the shared config.toml; only the shell_environment_policy deletions are still sent. The copy\'s values reach its backend per thread and, for the static baseline, as `-c` overrides (backend.configOverrides)';
  let cfgObj, crProp;
  if (inlines.length === 1) {
    const [all, tvar, , , obj, nodeReplProp, deletions, , , cr] = inlines[0];
    if (cr === nodeReplProp) return miss('the node_repl and cua_repl edits name the same config key');
    cfgObj = obj; crProp = cr;
    drafts.push({ id: 'managed-config-no-persist', seam: 'other', file, op: 'replace-once', find: all.slice(0, all.indexOf(';return await')), text: `let ${tvar}=${deletions}`, why: noPersistWhy });
  }
  const gcName = gcs[0]?.[1]; const nodeReplProp = gcs[0]?.[4];

  // the tool sync: let T=[...F(C),{keyPath:`mcp_servers.${r.q}`,…}];return await e.sendAppServerRequest(`config/batchWrite`,{edits:T,…
  const hcRe = gcName && new RegExp(`let (${ID})=\\[\\.\\.\\.${esc(gcName)}\\((${ID})\\),\\{keyPath:\`mcp_servers\\.\\$\\{(${ID})\\.(${ID})\\}\`,mergeStrategy:\`replace\`,value:(${ID})\\?null:(${ID})\\[\`mcp_servers\\.\\$\\{\\3\\.\\4\\}\`\\]\\}\\];return await (${ID})\\.sendAppServerRequest\\(\`config/batchWrite\`,\\{edits:\\1,`, 'g');
  const hcs = gcs.length ? [...text.matchAll(hcRe)] : [];
  if (gcs.length && hcs.length !== 1) return miss(`the managed tool sync (config/batchWrite with the node_repl and cua_repl edits) occurs ${hcs.length} times (expected exactly 1)`);
  if (gcs.length) {
  const [hcAll, tvar, cvar, obj, cr] = hcs[0];
  cfgObj = obj; crProp = cr;
  if (cr === nodeReplProp) return miss('the node_repl and cua_repl edits name the same config key');
  const hcHead = hcAll.slice(0, hcAll.indexOf(';return await'));
  drafts.push({ id: 'managed-config-no-persist', seam: 'other', file, op: 'replace-once', find: hcHead, text: `let ${tvar}=${gcName}(${cvar}).slice(1)`,
    why: noPersistWhy });
  }

  // the cua-repl plugin .mcp.json rewrite: only its write tail is replaced (the declarations in front of it are the app's own)
  const rneRe = new RegExp(`((${ID})=(${ID})\\.mcpServers\\.cua_repl[,;][^]{0,1500}?)let (${ID})=\`\\$\\{JSON\\.stringify\\(\\3,null,2\\)\\}(?:\\\\n|\\n)\`;if\\(\\4!==(${ID})\\)\\{let e=\`\\$\\{(${ID})\\}\\.tmp-\\$\\{\\(0,(${ID})\\.randomUUID\\)\\(\\)\\}\`;await ?\\(0,(${ID})\\.writeFile\\)\\(e,\\4\\),await ?\\(0,\\8\\.rename\\)\\(e,\\6\\)\\}return (${ID})\\}`, 'g');
  const rnes = [...text.matchAll(rneRe)];
  if (rnes.length !== 1) return miss(`the cua-repl plugin .mcp.json rewrite occurs ${rnes.length} times (expected exactly 1)`);
  const rm = rnes[0]; const cDef = rm[2]; const nVar = rm[9];
  // 22943 also writes a constant helper file into the same plugin cache just before (`await (0,F.writeFile)(tmp,'…'),await (0,F.rename)(tmp,path),`):
  // the find starts there, and what follows that write is kept
  const rneHead = rm[1];
  const boots = [...rneHead.matchAll(new RegExp(`await ?\\(0,(${ID})\\.writeFile\\)\\((${ID}),('[^'\\n]*'|"[^"\\n]*"|\`[^\`]*\`)\\),await ?\\(0,\\1\\.rename\\)\\(\\2,(${ID})\\),`, 'g'))];
  const boot = boots.at(-1);
  const kept = boot ? rneHead.slice(boot.index + boot[0].length) : '';
  const tail = boot ? rm[0].slice(boot.index) : rm[0].slice(rneHead.length);
  drafts.push({ id: 'managed-config-no-persist-cua-repl', seam: 'other', file, op: 'replace-once', find: tail, text: `${kept}return ${CUA_REPL_STASH}=${nVar}?structuredClone(${cDef}):null,${nVar}}`,
    why: 'D-M5-1: the plugin .mcp.json rewrite keeps computing the cua_repl definition (command, args, env, surfaces) but no longer rewrites the shared plugin cache .mcp.json; the definition is kept for the per-thread config' });

  // per-thread config: `!A?.cuaReplEnabled||C?.[node_repl]==null?{...C,...Stub}:( <cua_repl assignment>, Sel(C[node_repl],S.cuaReplSurfaces), C )`
  const head = `!(?<flag>${ID})\\?\\.cuaReplEnabled\\|\\|(?<c>${ID})\\?\\.\\[\`mcp_servers\\.node_repl\`\\]==null\\?\\{\\.\\.\\.\\k<c>,\\.\\.\\.(?<stub>${ID})\\}:\\(`;
  const slot = `\\k<c>\\[\`mcp_servers\\.\\$\\{${esc(cfgObj)}\\.${esc(crProp)}\\}\`\\]`;
  const nativeRe = new RegExp(`${head}(?<find>(?<u>${ID})!=null&&(?<l>${ID})!=null&&\\((?<assign>(?<lhs>${slot})=(?<mk>${ID})\\(\\{browserBackends:(?<s>${ID})\\.browserBackends,deferTools:\\k<s>\\.desktopFeatureAvailability\\.deferCuaTools,surfaces:\\k<s>\\.cuaReplSurfaces,nodeRepl:\\k<l>\\}\\))\\)),(?<sel>${ID})\\(\\k<c>\\[\`mcp_servers\\.node_repl\`\\],\\k<s>\\.cuaReplSurfaces\\),\\k<c>\\)`, 'g');
  const plainRe = new RegExp(`return${head}(?<sel>${ID})\\(\\k<c>\\[\`mcp_servers\\.node_repl\`\\],(?<s>${ID})\\.cuaReplSurfaces\\),\\k<c>\\)\\}`, 'g');
  const natives = [...text.matchAll(nativeRe)]; const plains = [...text.matchAll(plainRe)];
  const daemon = `${ID}(?:\\(\\))?\\.env\\.CODEX_APP_SERVER_USE_LOCAL_DAEMON`;
  const gatedRe = new RegExp(`(?<find>(?<g1>null!=(?<u>${ID})&&null!=(?<l>${ID}))(?<gate>&&(?:${Q}1${Q}===${daemon}|${daemon}===${Q}1${Q}))&&\\((?<assign>(?<lhs>${ID}\\[\`mcp_servers\\.\\$\\{${esc(cfgObj)}\\.${esc(crProp)}\\}\`\\])=(?<mk>${ID})\\(\\{browserBackends:(?<s>${ID})\\.browserBackends,deferTools:\\k<s>\\.desktopFeatureAvailability\\.deferCuaTools,surfaces:\\k<s>\\.cuaReplSurfaces,nodeRepl:(?:\\k<u>|\\k<l>)\\}\\))\\))`, 'g');
  const gated = natives.length + plains.length ? [] : [...text.matchAll(gatedRe)];
  if (natives.length + plains.length + gated.length !== 1) return miss(`the per-thread config assembly (node_repl when cua_repl is enabled, else the disabled stub) occurs ${natives.length + plains.length + gated.length} times (expected exactly 1)`);
  if (gated.length === 1) {
    // the app assigns cua_repl per thread only when its local daemon is in use: that stays; otherwise the copy's own definition
    const g = gated[0].groups;
    drafts.push({ id: 'managed-config-cua-repl-thread', seam: 'other', file, op: 'replace-once', find: g.find,
      text: `${g.g1}${g.gate}?${g.assign}:${CUA_REPL_STASH}!=null&&(${g.lhs}=structuredClone(${CUA_REPL_STASH}))`,
      why: 'D-M5-1: the app assigns the full cua_repl definition per thread itself only with its local daemon (CODEX_APP_SERVER_USE_LOCAL_DAEMON=1), and that stays; otherwise each thread gets the copy\'s own definition (kept by managed-config-no-persist-cua-repl), never the stock one from the shared plugin cache' });
  } else if (natives.length === 1) {
    // the app sets cua_repl itself when the cached principal id exists: keep that native assignment; only otherwise send the stash
    const g = natives[0].groups;
    drafts.push({ id: 'managed-config-cua-repl-thread', seam: 'other', file, op: 'replace-once', find: g.find,
      text: `${g.u}!=null&&${g.l}!=null?${g.assign}:${CUA_REPL_STASH}!=null&&(${g.lhs}=structuredClone(${CUA_REPL_STASH}))`,
      why: 'D-M5-1: the app sends the full cua_repl definition per thread itself when the cached principal id exists (richer than the plugin file: the per-thread node_repl env); that stays. Only when it does not, the copy\'s own definition (kept by managed-config-no-persist-cua-repl) is sent, so a thread never falls through to the stock definition in the shared plugin cache' });
  } else {
    const g = plains[0].groups;
    drafts.push({ id: 'managed-config-cua-repl-thread', seam: 'other', file, op: 'replace-once', find: plains[0][0],
      text: `return!${g.flag}?.cuaReplEnabled||${g.c}?.[\`mcp_servers.node_repl\`]==null?{...${g.c},...${g.stub}}:(${g.sel}(${g.c}[\`mcp_servers.node_repl\`],${g.s}.cuaReplSurfaces),${CUA_REPL_STASH}==null?${g.c}:{...${g.c},"mcp_servers.cua_repl":${CUA_REPL_STASH}})}`,
      why: 'D-M5-1: the copy\'s cua_repl definition travels with each thread (full table, which replaces the plugin-supplied one) instead of through the shared plugin cache' });
  }

  // dry run: every find applies exactly once, and nothing is persisted any more
  let patched = text;
  try { for (const d of drafts) patched = applyOp(patched, d); } catch (e) { return miss(`dry run failed: ${e.message}`); }
  const left = persistedManagedConfig(patched);
  if (left.length) return miss(`after the dry run managed configuration is still persisted: ${left.join(' | ')}`);
  return { drafts, missing: [] };
}
