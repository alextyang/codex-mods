// Semantic locators for the stock Codex/ChatGPT renderer and main bundles. Everything is found by shape, never by
// minified name, so the same code re-derives the pack for the next build (the tool refreshes; it never guesses).
// A locator that cannot resolve returns `missing` with what was tried; callers record it in NOTES.md.
//
// Input: a `source` { list(prefix) → string[] , read(path) → string } over the stock app.asar (or an extracted dir).
import { sealTransforms } from './transform.mjs';
import { deriveCuaContainerTransform } from './cua-container.mjs';
import { deriveManagedConfigTransforms } from './managed-config.mjs';
import { deriveCuaSkillsTransform } from './cua-skills.mjs';
import { deriveCuaPeerAuthTransform } from './cua-peer-auth.mjs';

const ID = '[A-Za-z_$][\\w$]*';
const esc = (s) => s.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&');

// ---------------------------------------------------------------------------------------------- brace matching
/** Index of the `}` closing the `{` at i, skipping strings and templates (enough for minified bundles). */
export function matchBrace(s, i, limit = 600000) {
  let depth = 0;
  const end = Math.min(s.length, i + limit);
  for (let p = i; p < end; p++) {
    const c = s[p];
    if (c === '"' || c === "'") { p++; while (p < end && s[p] !== c) { if (s[p] === '\\') p++; p++; } continue; }
    if (c === '`') {
      p++; let d = 0;
      while (p < end) {
        if (s[p] === '\\') { p += 2; continue; }
        if (s[p] === '`' && d === 0) break;
        if (s[p] === '$' && s[p + 1] === '{') { d++; p += 2; continue; }
        if (s[p] === '}' && d > 0) d--;
        p++;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return p; }
  }
  return -1;
}

/** Name of the nearest preceding top-level `function NAME(` whose body spans idx. */
export function enclosingFunction(s, idx) {
  let from = idx;
  for (let tries = 0; tries < 80; tries++) {
    const p = s.lastIndexOf('function ', from);
    if (p < 0) return null;
    from = p - 1;
    const m = new RegExp(`^function (${ID})\\(`).exec(s.slice(p, p + 80));
    if (!m) continue;
    const b = s.indexOf('{', p);
    const e = matchBrace(s, b);
    if (e > idx && /[;}\n)]|^$/.test(s[p - 1] ?? '')) return { name: m[1], start: p, end: e };
  }
  return null;
}

const INIT_RE = new RegExp(`function (${ID})\\(\\)\\{return\\(\\1=${ID}\\(\\(\\(\\)=>\\{`, 'g');
/** All lazy-module init functions `function X(){return(X=e((()=>{...})))()}` with their body spans. */
export function initFunctions(s) {
  const out = [];
  INIT_RE.lastIndex = 0;
  for (let m; (m = INIT_RE.exec(s));) {
    const bodyOpen = m.index + m[0].length - 1;          // the `{` of `()=>{`
    const bodyClose = matchBrace(s, bodyOpen);
    out.push({ name: m[1], start: m.index, bodyOpen, bodyClose });
  }
  return out;
}

/** The init function that makes `local` (and the functions around it) usable, or null.
 *  A `var`/`let` assigned inside an init body → that init. A function declaration → the first init that follows it. */
export function initFor(s, inits, local, kind, position) {
  if (kind === 'assigned') return inits.find((f) => f.bodyOpen < position && position < f.bodyClose) ?? null;
  return inits.find((f) => f.start > position) ?? null;
}

// ---------------------------------------------------------------------------------------------- source helpers
const LOCALE_CHUNK = /\/(?:[a-z]{2,3}(?:-[A-Za-z0-9]{2,4})?)-[0-9a-f]{12}\.js$/;
const SOURCEMAP_RE = /\/\/# sourceMappingURL=[^\n]+\.js\.map/g;

/** Chunks worth scanning: not locale bundles, big enough to hold the UI kit. */
export function candidateChunks(source) {
  return source.list('webview/assets/').filter((p) => p.endsWith('.js') && !LOCALE_CHUNK.test('/' + p.split('/').pop()) && source.size(p) > 100_000);
}

function sourceMapComment(text, file) {
  const all = text.match(SOURCEMAP_RE) ?? [];
  if (all.length !== 1) throw new Error(`${file}: expected exactly one sourceMappingURL comment, found ${all.length}`);
  return all[0];
}

// ---------------------------------------------------------------------------------------------- component locators
/** Each locator: a regex with a named group `name` (the local binding) plus `kind`: 'function' (declaration) or 'assigned' (var set in an init). */
const COMPONENT_LOCATORS = {
  Button: { kind: 'assigned', re: new RegExp(`(?<name>${ID})=e=>\\{let\\{type:${ID}=\`button\`,color:${ID}=\`primary\`,variant:${ID}=\`solid\``) },
  Switch: { kind: 'function', re: new RegExp(`function (?<name>${ID})\\(e\\)\\{[^]{0,260}?\\(\\{checked:${ID},onChange:${ID},disabled:${ID},className:${ID},id:${ID},ariaLabel:${ID},size:${ID},tone:${ID},trackClassName:`) },
  Dialog: { kind: 'function', re: new RegExp(`function (?<name>${ID})\\(e\\)\\{"use forget";[^]{0,900}?\\(\\{children:${ID},modal:${ID},autoFocusCloseButton:${ID},triggerContent:${ID},triggerAsChild:`) },
  DialogHeader: { internal: true, kind: 'function', re: new RegExp(`function (?<name>${ID})\\(e\\)\\{let t=\\(0,${ID}\\.c\\)\\(\\d+\\),\\{icon:${ID},title:${ID},subtitle:${ID},className:${ID},iconClassName:${ID},iconBackgroundClassName:`) },
  DialogBody: { internal: true, kind: 'function', re: new RegExp(`function (?<name>${ID})\\(e\\)\\{"use forget";let t=\\(0,${ID}\\.c\\)\\(\\d+\\),\\{children:${ID},className:${ID},size:${ID},variant:${ID}\\}=e,`) },
  DialogFooter: { internal: true, kind: 'function', re: new RegExp(`function (?<name>${ID})\\(e\\)\\{let t=\\(0,${ID}\\.c\\)\\(\\d+\\),\\{children:${ID},className:${ID},expandSingleButton:`) },
  Tooltip: { kind: 'function', re: new RegExp(`function (?<name>${ID})\\(e\\)\\{let t=\\(0,${ID}\\.c\\)\\(\\d+\\);\\(0,${ID}\\.useContext\\)\\(${ID}\\);let n=\\(0,${ID}\\.useContext\\)\\(${ID}\\);if\\(e\\.disabled\\|\\|e\\.tooltipContent==null\\)`) },
  Icon: { kind: 'function', re: new RegExp(`function (?<name>${ID})\\(e\\)\\{let t=\\(0,${ID}\\.c\\)\\(\\d+\\),n,r,i,a,o;[^]{0,160}?\\(\\{className:n,icon:r,legacyClassName:a,size:o,\\.\\.\\.i\\}=e`) },
  SettingsRow: { kind: 'function', re: new RegExp(`function (?<name>${ID})\\(e\\)\\{let t=\\(0,${ID}\\.c\\)\\(\\d+\\),\\{label:${ID},labelSizing:${ID},labelWeight:${ID},layout:${ID},description:${ID},control:${ID},controlSizing:`) },
  Menu: { kind: 'function', re: new RegExp(`function (?<name>${ID})\\(e\\)\\{"use forget";let t=\\(0,${ID}\\.c\\)\\(\\d+\\),\\{triggerButton:${ID},disabled:${ID},children:${ID},loadingContent:`) },
  MenuParts: { kind: 'assigned', re: new RegExp(`(?<name>${ID})=\\{focusMenuItem:${ID},Trigger:${ID},Content:${ID},Item:${ID},`) },
  TextField: { kind: 'function', re: new RegExp(`function (?<name>${ID})\\(e\\)\\{let t=\\(0,${ID}\\.c\\)\\(\\d+\\),n,r,i,a,o,s,c,l,u,d,f;[^]{0,200}?\\(\\{autoSize:${ID},id:${ID},ref:${ID},type:${ID},leadingControl:`) },
  SettingsSection: { kind: 'assigned', re: new RegExp(`(?<name>${ID})=Object\\.assign\\((?<root>${ID}),\\{Header:(?<header>${ID}),Content:(?<content>${ID})(?:,Footer:${ID})?\\}\\)`), verify: (src, g) =>
    new RegExp(`function ${esc(g.root)}\\(e\\)\\{[^]{0,200}?\\{children:${ID},id:${ID},className:${ID}\\}=e`).test(src)
    && new RegExp(`function ${esc(g.header)}\\(e\\)\\{[^]{0,360}?\\{title:${ID},subtitle:${ID},actions:${ID},actionsAlignment:`).test(src) },
};
export const COMPONENT_KEYS = Object.freeze(Object.keys(COMPONENT_LOCATORS).filter((k) => !COMPONENT_LOCATORS[k].internal).concat('DialogParts'));

/** Locate React (the CJS `require_react` wrapper and its alias) and react-dom/react-dom-client wrappers. */
function locateReact(src) {
  const useState = src.indexOf('e.useSyncExternalStore=function');
  if (useState < 0) return null;
  const wrapRe = new RegExp(`(?:^|[,;\\s])(${ID})=(${ID})\\(\\(\\(?e\\)?=>\\{`, 'g');
  const lastWrapper = (idx) => { let last = null; wrapRe.lastIndex = 0; for (let m; (m = wrapRe.exec(src)) && m.index < idx;) last = m; return last; };
  const reactWrap = lastWrapper(useState);
  if (!reactWrap) return null;
  const alias = new RegExp(`(?:^|[,;\\s])(${ID})=${esc(reactWrap[2])}\\(\\(\\(e,t\\)=>\\{t\\.exports=${esc(reactWrap[1])}\\(\\)\\}\\)\\)`).exec(src);
  const portal = src.indexOf('e.createPortal=function');
  const root = src.indexOf('e.createRoot=function');
  if (!alias || portal < 0 || root < 0) return null;
  const domWrap = lastWrapper(portal);
  const clientWrap = lastWrapper(root);
  if (!domWrap || !clientWrap) return null;
  return { react: alias[1], reactDom: domWrap[1], reactDomClient: clientWrap[1] };
}

// ---------------------------------------------------------------------------------------------- seams (G-tree)
/** The app-shell namespace object (kG in 20156): located by its un-minified member names, never by its minified name. */
const APP_SHELL_RE = new RegExp(`(?<ns>${ID})=\\{[^{}]*?HeaderAction:\\(0,(?<R>${ID})\\.memo\\)\\(${ID}\\),[^{}]*?HeaderToolbar:Object\\.assign\\(\\(0,\\k<R>\\.memo\\)\\((?<hf>${ID})\\),\\{Actions:(?<act>${ID})\\}\\)`);
/** Scope definitions are created by `NAME=make(\`RouteScope\`,{key:…`: the scope's own name string is the locator. */
const scopeRe = (name) => new RegExp(`(?<name>${ID})=${ID}\\(\`${name}\`,\\{key:`);
/** useScope(scope): the hook that reads a scope's context chain (shape of its first statements). */
const USE_SCOPE_RE = new RegExp(`function (?<name>${ID})\\(e\\)\\{let t=\\(0,${ID}\\.useContext\\)\\(${ID}\\(e\\)\\),n=${ID}\\(t,e\\),r=${ID}\\(n\\),i=\\(0,${ID}\\.useRef\\)\\(null\\);if\\(i\\.current==null\\|\\|i\\.current\\.node!==n\\)\\{let a=\\{chain:t,getOwnValue`);

/** Side-panel tab registry (G-panel). `registerTabType(kind, Component, options)` writes into the app's tab-type map; the right-panel controller
 *  (`panelId:\`right\``) opens tabs; the side-chat tab component is the app's own "show another conversation next to this one" view. */
const REGISTER_TAB_TYPE_RE = new RegExp(`function (?<name>${ID})\\(e,t,n\\)\\{let r=\\{\\.\\.\\.n,externalDrop:n\\.externalDrop\\?\\?${ID}\\.get\\(e\\)\\?\\.externalDrop,Component:t,dropDestinations:`);
const RIGHT_PANEL_RE = new RegExp(`(?<name>${ID})=${ID}\\(\\{panelId:\`right\`,getPanelOpenSignal:`);
const SIDE_CHAT_TAB_RE = new RegExp(`(?<name>${ID})=${ID}\\(async\\(\\)=>\\(await ${ID}\\(async\\(\\)=>\\{let\\{LocalConversationSideChatTab:e\\}=await import\\(`);

/** Conversation manager getter `getManager(scope, hostId)`: the app calls `.ensureConversationHistoryLoaded(conversationId, parents)` on it. Located by that method name; the callee is a binding of the chunk. */
const CONVERSATION_MANAGER_RE = new RegExp(`(?<name>${ID})\\(${ID},${ID}\\.get\\(${ID},${ID}\\)\\)\\.ensureConversationHistoryLoaded\\(`);

/** The wrapper the seam puts around the app's HeaderToolbar (an arrow function `(Toolbar, React) => Component`, as source text).
 *  It renders the toolbar unchanged plus one stable slot component as the LAST child. The slot renders the framework host
 *  `globalThis.__codexmods.hosts['thread.header']` (set by the renderer runtime; absent = renders nothing) and re-renders when the runtime
 *  announces a host later than first render. The slot is created once, so the React Compiler's cached elements around the toolbar never hold stale contributions:
 *  contributions live in the host's own store subscription, not in any element the app caches. Nothing here is feature policy. */
export const HEADER_TOOLBAR_WRAPPER = '(M,R)=>{let S=function(){let[,u]=R.useReducer(n=>n+1,0);R.useEffect(()=>{let f=()=>u();window.addEventListener(`codexmods:hosts`,f);return()=>window.removeEventListener(`codexmods:hosts`,f)},[]);let H=globalThis.__codexmods?.hosts?.[`thread.header`];return H?R.createElement(H):null};return R.memo(function CodexModsHeaderToolbar(p){return R.createElement(M,p,R.createElement(R.Fragment,null,p.children,R.createElement(S)))})}';

/** Seam exposures (merged into the exposure insertion of the chunk that holds them) and the host seam transform.
 *  Returns { exposures: Map<file, [key, expr][]>, hostDrafts, missing, evidence }. */
export function deriveSeams(source, chunks, text) {
  const exposures = new Map(); const hostDrafts = []; const missing = []; const evidence = {};
  const add = (file, key, expr) => { if (!exposures.has(file)) exposures.set(file, []); exposures.get(file).push([key, expr]); };
  const initExpr = (src, local, position) => { const init = initFor(src, initFunctions(src), local, 'assigned', position); return init ? `(${init.name}(),${local})` : local; };
  let shell = null;
  for (const file of chunks) { const src = text(file); const m = APP_SHELL_RE.exec(src); if (m) { shell = { file, m, src }; break; } }
  if (shell) {
    const { file, m, src } = shell; const g = m.groups;
    add(file, 'AppShell', initExpr(src, g.ns, m.index));
    hostDrafts.push({ id: 'seam-host:thread-header', seam: 'host', file, op: 'replace-once',
      find: `HeaderToolbar:Object.assign((0,${g.R}.memo)(${g.hf}),{Actions:${g.act}})`,
      text: `HeaderToolbar:Object.assign((${HEADER_TOOLBAR_WRAPPER})((0,${g.R}.memo)(${g.hf}),${g.R}),{Actions:${g.act}})`,
      why: 'thread header host: the framework component for surface thread.header.action renders as the last child of every HeaderToolbar, inside the route and thread scope providers; located by the namespace member names HeaderAction and HeaderToolbar' });
    evidence.appShell = { file, ns: g.ns };
  } else missing.push({ item: 'seam:thread.header', tried: 'namespace object with members HeaderAction … HeaderToolbar:Object.assign(memo(F),{Actions:A}) in webview/assets chunks > 100 KB' });
  for (const key of ['RouteScope', 'ThreadScope']) {
    let hit = null;
    for (const file of chunks) { const src = text(file); const m = scopeRe(key).exec(src); if (m) { hit = { file, m, src }; break; } }
    if (hit) { add(hit.file, key, initExpr(hit.src, hit.m.groups.name, hit.m.index)); evidence[key] = { file: hit.file, local: hit.m.groups.name }; }
    else missing.push({ item: `seam-export:${key}`, tried: `NAME=make(\`${key}\`,{key: … in webview/assets chunks > 100 KB` });
  }
  let us = null;
  for (const file of chunks) {
    const src = text(file); const m = USE_SCOPE_RE.exec(src);
    if (!m) continue;
    const f = enclosingFunction(src, m.index + m[0].length - 1); const after = f ? initFunctions(src).find((x) => x.start > f.end) : null;
    us = { file, local: m.groups.name, initName: after?.name ?? null }; break;
  }
  if (us) { add(us.file, 'useScope', us.initName ? `(${us.initName}(),${us.local})` : us.local); evidence.useScope = us; }
  else missing.push({ item: 'seam-export:useScope', tried: 'hook shape useContext(ctx(e)) … getOwnValue in webview/assets chunks > 100 KB' });
  // panel tab registry (G-panel): three exposures, each located by shape
  for (const [key, re, kind] of [['registerTabType', REGISTER_TAB_TYPE_RE, 'function'], ['rightPanel', RIGHT_PANEL_RE, 'assigned'], ['SideChatTab', SIDE_CHAT_TAB_RE, 'assigned'], ['conversationManager', CONVERSATION_MANAGER_RE, 'binding']]) {
    let hit = null;
    for (const file of chunks) { const src = text(file); const m = re.exec(src); if (m) { hit = { file, m, src }; break; } }
    if (!hit) { missing.push({ item: `seam-export:${key}`, tried: `shape ${re.source.slice(0, 100)}… in webview/assets chunks > 100 KB` }); continue; }
    let expr = hit.m.groups.name;
    if (kind === 'assigned') expr = initExpr(hit.src, hit.m.groups.name, hit.m.index);
    else if (kind === 'binding') expr = hit.m.groups.name;
    else { const f = enclosingFunction(hit.src, hit.m.index + hit.m[0].length - 1); const after = f ? initFunctions(hit.src).find((x) => x.start > f.end) : null; if (after) expr = `(${after.name}(),${hit.m.groups.name})`; }
    add(hit.file, key, expr); evidence[key] = { file: hit.file, local: hit.m.groups.name, expr };
  }
  return { exposures, hostDrafts, missing, evidence };
}

function exposureText(entries) {
  const body = entries.map(([k, expr]) => `${JSON.stringify(k)}:()=>${expr}`).join(',');
  return `;(()=>{let x=(globalThis.__codexmods??={exports:{}}).exports??={};for(let[k,g]of Object.entries({${body}}))Object.defineProperty(x,k,{get:g,configurable:!0,enumerable:!0})})();\n`;
}

/**
 * Component exposure seam. Returns { drafts, components, react, missing, evidence }.
 *   drafts     one insertion per chunk (SeamTransform minus hashes)
 *   components ComponentName → exports key (only the located ones)
 *   missing    [{item, tried}]
 */
export function deriveComponents(source) {
  const chunks = candidateChunks(source);
  const found = new Map();           // key → { file, local, initName, offset }
  const missing = [];
  let reactInfo = null; let reactFile = null;
  const texts = new Map();
  const text = (p) => { if (!texts.has(p)) texts.set(p, source.read(p)); return texts.get(p); };

  for (const file of chunks) {
    const src = text(file);
    if (!reactInfo && src.includes('e.useSyncExternalStore=function')) {
      const r = locateReact(src);
      if (r) { reactInfo = r; reactFile = file; }
    }
    let inits = null;
    for (const [key, loc] of Object.entries(COMPONENT_LOCATORS)) {
      if (found.has(key)) continue;
      const m = loc.re.exec(src);
      if (!m) continue;
      if (loc.verify && !loc.verify(src, m.groups)) continue;
      inits ??= initFunctions(src);
      const local = m.groups.name;
      const position = loc.kind === 'assigned' ? m.index : m.index;
      const init = initFor(src, inits, local, loc.kind, position)
        ?? (loc.kind === 'function' ? null : null);
      // for function declarations the end of the function is the better anchor for "next init"
      let initName = init?.name ?? null;
      if (loc.kind === 'function') {
        const f = enclosingFunction(src, m.index + m[0].length - 1);
        const after = f ? inits.find((x) => x.start > f.end) : null;
        initName = after?.name ?? null;
      }
      found.set(key, { file, local, initName, offset: m.index });
    }
  }

  const byFile = new Map();
  const add = (file, key, expr) => { if (!byFile.has(file)) byFile.set(file, []); byFile.get(file).push([key, expr]); };
  if (reactInfo) {
    add(reactFile, 'react', `${reactInfo.react}()`);
    add(reactFile, 'reactDom', `({...${reactInfo.reactDom}(),...${reactInfo.reactDomClient}()})`);
  } else {
    missing.push({ item: 'react', tried: 'CJS wrapper around e.useSyncExternalStore / createPortal / createRoot in webview/assets chunks > 100 KB' });
  }
  for (const [key, info] of found) {
    if (COMPONENT_LOCATORS[key].internal) continue;
    add(info.file, key, info.initName ? `(${info.initName}(),${info.local})` : info.local);
  }
  // DialogParts: Header/Body/Footer of the dialog layout, only when all three sit in the Dialog's own chunk.
  const dh = found.get('DialogHeader'); const db = found.get('DialogBody'); const df = found.get('DialogFooter'); const dd = found.get('Dialog');
  if (dd && dh && db && df && dh.file === dd.file && db.file === dd.file && df.file === dd.file) {
    const inits = [...new Set([dh.initName, db.initName, df.initName].filter(Boolean))].map((n) => `${n}()`).join(',');
    add(dd.file, 'DialogParts', `(${inits ? `${inits},` : ''}{Header:${dh.local},Body:${db.local},Footer:${df.local}})`);
  } else {
    missing.push({ item: 'component-parts:DialogParts', tried: 'Header/Body/Footer shape locators next to the Dialog root' });
  }
  for (const key of ['Button', 'Switch', 'TextField', 'Select', 'Menu', 'Dialog', 'SettingsSection', 'SettingsRow', 'Tooltip', 'Icon']) {
    if (!found.has(key)) {
      missing.push({ item: `component:${key}`, tried: key === 'Select'
        ? 'no standalone select control: the app builds selects from the Dropdown (Menu) plus items; looked for role=combobox/listbox wrappers, SelectTrigger, <select>'
        : `shape locator for ${key} in webview/assets chunks > 100 KB` });
    }
  }

  const seams = deriveSeams(source, chunks, text);
  for (const [file, entries] of seams.exposures) for (const [k, e] of entries) add(file, k, e);
  missing.push(...seams.missing);

  const drafts = [];
  for (const [file, entries] of byFile) {
    const src = text(file);
    const comment = sourceMapComment(src, file);
    drafts.push({
      id: `expose-components:${file.split('/').pop().replace(/-[0-9a-f]{12}\.js$/, '')}`,
      seam: 'components', file, op: 'insert-before-once', find: comment, text: exposureText(entries),
    });
  }
  drafts.sort((a, b) => a.file.localeCompare(b.file));
  drafts.push(...seams.hostDrafts);

  const components = {};
  for (const key of COMPONENT_KEYS) if (found.has(key) && key !== 'MenuParts' && key !== 'DialogParts') components[key] = key;
  return {
    drafts, components,
    react: reactInfo ? { react: 'react', reactDom: 'reactDom' } : null,
    missing,
    evidence: { react: reactInfo ? { file: reactFile, ...reactInfo } : null, components: Object.fromEntries(found), seams: seams.evidence },
    seamHosts: seams.hostDrafts.map((d) => d.id),
  };
}

// ---------------------------------------------------------------------------------------------- trusted sender (main)
/** True when the webContents' URL is the app's own page marked as a framework view (codexmodsView=1). */
const viewCheck = (ref) => `(()=>{try{let t=new URL(${ref}.getURL());return t.protocol===\`app:\`&&t.hostname===\`-\`&&t.pathname===\`/index.html\`&&t.searchParams.get(\`codexmodsView\`)===\`1\`}catch{return!1}})()`;
export const VIEW_CHECK = viewCheck;

const MAIN_LOCATORS = {
  'trusted-view-context': {
    re: new RegExp(`getContextForWebContents:(?<e>${ID})=>(?<mgr>${ID})\\.hasRegisteredWebContents\\(\\k<e>\\)\\?(?<ctx>${ID}):null`),
    build: (g) => `getContextForWebContents:${g.e}=>${g.mgr}.hasRegisteredWebContents(${g.e})||${viewCheck(g.e)}?${g.ctx}:null`,
    why: 'app view context: main hands the shared app context to framework views (webContents whose URL carries codexmodsView=1)',
  },
  'trusted-view-sender': {
    re: new RegExp(`isTrustedIpcSender\\((?<e>${ID}),(?<t>${ID})\\)\\{return \\k<e>\\.id!=null&&!this\\.registeredWebContentsIds\\.has\\(\\k<e>\\.id\\)\\?!1:(?<check>${ID})\\(\\{sender:\\k<e>,senderFrame:\\k<t>,moduleDir:this\\.options\\.moduleDir\\}\\)\\}`),
    build: (g) => `isTrustedIpcSender(${g.e},${g.t}){return ${g.e}.id!=null&&!this.registeredWebContentsIds.has(${g.e}.id)&&!${viewCheck(g.e)}?!1:${g.check}({sender:${g.e},senderFrame:${g.t},moduleDir:this.options.moduleDir})}`,
    why: 'trusted IPC sender: unregistered framework views pass the registration test; the main-frame and app-URL test (still applied) is unchanged',
  },
  'trusted-view-startup': {
    re: new RegExp(`async whenReady\\(\\)\\{if\\(!this\\.isRendererAvailable\\(\\)\\)`),
    build: () => `async whenReady(){if(${viewCheck('this.origin')})return;if(!this.isRendererAvailable())`,
    why: 'primary-startup handshake: a framework view is never the primary window, so whenReady must not throw AbortError for it',
  },
};

/** Locate the main-process bundle by content and derive the three trusted-sender replacements. */
export function deriveTrustedSender(source) {
  const mains = source.list('.vite/build/').filter((p) => /\/main-[^/]+\.js$/.test(p));
  const missing = [];
  for (const file of mains) {
    const src = source.read(file);
    if (!src.includes('isTrustedIpcSender(')) continue;
    const drafts = [];
    for (const [id, loc] of Object.entries(MAIN_LOCATORS)) {
      const m = loc.re.exec(src);
      if (!m) { missing.push({ item: `transform:${id}`, tried: `regex ${loc.re.source.slice(0, 120)}… in ${file}` }); continue; }
      drafts.push({ id, seam: 'trusted-sender', file, op: 'replace-once', find: m[0], text: loc.build(m.groups ?? {}), why: loc.why });
    }
    return { drafts, missing };
  }
  return { drafts: [], missing: [{ item: 'transform:trusted-sender', tried: 'no .vite/build/main-*.js containing isTrustedIpcSender(' }] };
}

/** All asar transforms, sealed with hashes. (The keychain name is a binary patch, not an asar transform: see binary-patch.mjs.) */
export function deriveTransforms(source) {
  const comp = deriveComponents(source);
  const trust = deriveTrustedSender(source);
  const cua = deriveCuaContainerTransform(source);
  const managed = deriveManagedConfigTransforms(source);
  const skills = deriveCuaSkillsTransform(source);
  const peer = deriveCuaPeerAuthTransform(source);
  const drafts = [...comp.drafts, ...trust.drafts, ...cua.drafts, ...managed.drafts, ...skills.drafts, ...peer.drafts];
  const transforms = sealTransforms(drafts, (p) => source.read(p));
  return { transforms, components: comp.components, react: comp.react, missing: [...comp.missing, ...trust.missing, ...cua.missing, ...managed.missing, ...skills.missing, ...peer.missing], evidence: comp.evidence, why: Object.fromEntries(drafts.filter((d) => d.why).map((d) => [d.id, d.why])), seams: comp.seamHosts };
}

/** Adapter-source over an opened asar (adapters/tools/asar.mjs openAsar). */
export function sourceFromAsar(asar) {
  return {
    list: (prefix) => asar.list().filter((p) => p.startsWith(prefix)),
    read: (p) => asar.read(p).toString('utf8'),
    size: (p) => asar.entry(p).size,
  };
}
