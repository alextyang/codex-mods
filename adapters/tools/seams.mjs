// Build-time UI seams (docs/design/presentations.md V1, V2): the edits of the app's own code that the presentation runtime stands on.
// Each seam is DERIVED for the build at hand from strings and structure (never from a minified name, a chunk name or a React Compiler cache
// size), checked to match exactly once, and emitted as a hash-sealed SeamTransform. A site that is absent, duplicated or changed is `missing`;
// nothing is guessed. The edits are inert: patched app code calls members of `globalThis.__codexmods`, and when a member is absent or throws the
// app's own behaviour runs (a throw is counted in `__codexmods.faults`).
//
// Groups apply whole or not at all (the refresh and the generator treat each group as one unit):
//   jsx        the renderer's JSX factory (one `replace-once` in the React jsx-runtime wrapper)
//   lazy       the Vite preload helper, wrapped so each lazily loaded module can be replaced
//   taps       the three command tables (descriptors, handlers, messages): all three or none
//   menus      the item builder of a thread's menus (the sidebar row's and the thread header's): its items pass `__codexmods.menuItems`
//   app-host   main process: the AppHost the app creates for each window, handed to `__codexmods.appHost`
//   expose:<role>   one append-only block of getters per renderer chunk, naming the app's own objects under `__codexmods.exports`
//
// The hook ABI (HOOKS below) is versioned with `ABI`; a pack declares the version in `seams.hooks.abi`.
//
// Input: a `source` { list(prefix) → string[], read(path) → string, size(path) → bytes } over the stock app.asar or an extraction of it.
import { matchClose, enclosingFunction } from './scan.mjs';
import { applyAll, applyOp, fileStem, findMainBundle, isMainBundle, sha256 } from './transform.mjs';
import { rspackModules, moduleAt, moduleHead, isRspackChunk } from './rspack.mjs';

export const ABI = 1;

/**
 * The hook API as emitted into the app's code. Every member of `globalThis.__codexmods` is optional; the page kernel (renderer) and
 * framework-main (main process) define them.
 */
export const HOOKS = Object.freeze({
  jsx: '(factory, type, props, key) => element | null | undefined   renderer; a null or undefined result, or a throw, falls back to factory(type, props, key)',
  lazy: '(importerSource: string, module) => module | null | undefined   renderer; a null or undefined result means "unchanged"; a throw leaves the module unchanged',
  taps: '{ commands?: descriptor[], handlers?: [id, fn][], messages?: { [id]: message } }   renderer; read once, when the command chunks evaluate',
  menuItems: '(args: { target: { conversationId, hostId, cwd }, surface, ... }, items) => items   renderer; a thread menu\'s items before they show; anything but an array, or a throw, keeps the app\'s items',
  launcher: '(list, { surface, target }) => list   renderer; the panels\' tool list before the app\'s filter; anything but an array, or a throw, keeps the app\'s list',
  markdownComponents: '(options, components) => components   renderer; the app\'s markdown components ({a, code}) as a markdown site builds them; anything but an object, or a throw, keeps the app\'s',
  markdownDirectives: '(options, directives) => directives   renderer; the app\'s default markdown directives as a markdown site builds them; anything but an object, or a throw, keeps the app\'s',
  markdownText: '(props, renderText) => renderText | {renderText?, tokens?}   renderer; the markdown renderer\'s props (its site: textStyle, className, conversationId, tokens, ...) and its text tokens\' renderer; a function answered draws them, an object\'s renderText and tokens replace the site\'s, anything else or a throw keeps the site\'s',
  pullRequestCreate: '(arg) => {refused} | {handled: {url, number?}} | undefined   renderer; a pull request the user creates (either of the app\'s routes, the gh CLI or the GitHub connector), asked before the route runs: refused, it throws that reason; handled, its pull request is the answer; anything else, or a throw, the app\'s own',
  reviewAction: '(arg, run) => result | undefined   renderer; the review panel\'s git action (a file\'s, a part\'s or a section\'s stage, unstage or revert: its argument as the app gives it) asks first, `run()` the app\'s own (at most once); anything but undefined answered is its answer (the hook ran it or holds it), undefined or a throw before it ran the app\'s own',
  attach: '(methods, args) => methods   renderer; a composer\'s attach methods as the app makes them (addFiles, addPickedFiles, addImages, ...) with the factory\'s arguments; an object answered is used in their place, anything else or a throw the app\'s own',
  command: '(id, keyboardEvent, source, origin, run) => boolean | undefined   renderer; the page\'s command dispatcher asks first, `run(event?)` its own dispatch (at most once; an event given replaces the one it had); a boolean answered is its answer (the hook ran it or holds it); anything else, or a throw before it ran, the app\'s own; once it ran, never again (its throw is the dispatcher\'s)',
  destinations: '(list, {location, navigate}) => list   renderer; the rail\'s and the sidebar\'s navigation as the app builds it, before its split into pinned and more (layouts WL5b); anything but an array, or a throw, keeps the app\'s list',
  useDestinationsRev: '() => number   renderer; a hook the destinations\' provider calls on every render: it renders again when the mods\' destinations change',
  destinationsRev: '() => number   renderer; the mods\' destinations\' revision, which a compiler memo block around the list compares',
  railMode: '(location) => boolean   renderer; true gives a mod\'s page the app\'s contextual sidebar column where the rail shows (layouts WL5c); never turns the rail on',
  PageRoute: 'a component   renderer; the element of the framework\'s route for a mod\'s page, `/codexmods/page/:mod/:page`, in the app\'s route tree from module load (layouts WL5a)',
  responsive: '({width, scope}) => true | undefined   renderer; the workspace column\'s narrow-window handler asks first on each change of the shell\'s width and once when a column mounts; true: the framework owns the window\'s responsive arrangement (the handler returns before it reads or writes anything), anything else or a throw the app\'s thresholds',
  sidebarGroups: '(keys: string[]) => string[]   renderer; the conversations sidebar\'s group keys (pinned, agents, threads, chats, custom:<id>) as the app orders and shows them, before its drag controller, its lists and its shortcuts read them; a permutation answered is used, anything else or a throw keeps the app\'s',
  copy: '(content, event, origin) => content   renderer; what the app\'s copy helper is given (a string, a promise of one, or {"text/plain", "text/html"}), the event that asked, and where a thread action\'s copy is from (seam copy-origin: {chat: id} or {content: false}); what it answers is copied, null or a throw copies the content as it was',
  appHost: '(host, sender) => void   main process; once per window, after the AppView is registered; host may be undefined',
  mainModules: '{ [id]: { exports } }   main process; written (data, not called) by a webpack build\'s runtime as it starts: its module cache (seam main-modules)',
  exports: '{ [key]: value }   renderer; defined by the exposure blocks as lazy, cached getters (see EXPOSURES)',
  faults: '{ jsx?: number, lazy?: number, menuItems?: number, launcher?: number, markdown?: number, copy?: number, command?: number, attach?: number, reviewAction?: number, pullRequestCreate?: number, appHost?: number, sidebarGroups?: number, responsive?: number }   optional; the seams count a throw from a hook here',
});

export const ID = '[A-Za-z_$][\\w$]*';
const esc = (s) => s.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&');

/**
 * A RegExp from source text where `@name@` is a minified-name capture on its first use and a back-reference after. A string literal's quote written
 * as an escaped backtick matches any quote: rolldown (up to 22943) writes template literals, rspack (25679 on) quoted strings.
 */
export const rx = (text, flags = 'g') => {
  const seen = new Set();
  const out = text.replace(/@(\w+)@/g, (_m, n) => {
    if (seen.has(n)) return `\\k<${n}>`;
    seen.add(n);
    return `(?<${n}>${ID})`;
  }).replaceAll('\\`', '[`"\']');
  return new RegExp(out, flags);
};
/** A needle as each bundler writes it: a backtick literal is also looked for as a double-quoted string (rspack), unless it is a template with holes. */
export const spellings = (needle) => (needle.includes('`') && !needle.includes('${') ? [needle, needle.replaceAll('`', '"')] : [needle]);

// ---------------------------------------------------------------------------------------------- anchors (shared with the census)
/** The React jsx-runtime wrapper: `X.Fragment=F,X.jsx=G,X.jsxs=G}` (jsx and jsxs are one function); rspack writes the fragment inline, `Symbol.for("react.fragment")`. */
export const JSX_RE = rx(String.raw`@ns@\.Fragment=(?<frag>[A-Za-z_$][\w$]*|Symbol\.for\(\`react\.fragment\`\)),\k<ns>\.jsx=@factory@,\k<ns>\.jsxs=\k<factory>\}`);
/** The Vite preload helper `N=function(importer,deps,base){let r=Promise.resolve();if(deps&&deps.length>0){let importer=document.getElementsByTagName(`link`)`. */
export const LAZY_RE = rx(String.raw`@name@=function\(@imp@,@deps@,@base@\)\{let @r@=Promise\.resolve\(\);if\(\k<deps>&&\k<deps>\.length>0\)\{(?<tail>let \k<imp>=document\.getElementsByTagName\(\`link\`\))?`);
/** The helper's chunk also holds Vite's `vite:preloadError` event exactly once. */
export const LAZY_GUARD = 'vite:preloadError';
/** The command descriptors, handlers and messages. */
export const TAP_TABLE_RE = rx(String.raw`@name@=\[\{id:\`newTask\`,`);
export const TAP_HANDLERS_RE = rx(String.raw`@name@=new Map\(\[\[\`newTask\`,`);
export const TAP_MESSAGES_RE = rx(String.raw`@name@=\{\.\.\.@base@,"codex\.command\.importExternalAgent":`);
/** The item builder of a thread's menus: `async function F({scope:S,target:T,actions:A,…,showForkInSidebar:…,…})` (its parameter names are the app's own). */
export const MENU_RE = rx(String.raw`async function @name@\(\{scope:@scope@,target:@target@,actions:@actions@,[^()]{0,400}?showForkInSidebar:`);
export const MENU_NEEDLE = 'showForkInSidebar:';
// The panels' launcher (mod-surfaces.md §3.1, E8.2b): one filter takes the tool list every launcher shows (the "+" menus, the New tab page,
// the empty panel, the omnibox, the panel toggle) with the surface and target: `function F(list,{codexFeatureAccess,surface,target}){…}`.
export const LAUNCHER_RE = rx(String.raw`function @name@\(@list@,\{codexFeatureAccess:@access@,surface:@surface@,target:@target@\}\)\{let @ok@=(?:\k<access>\.status===\`allowed\`|\`allowed\`===\k<access>\.status)[^{}]{0,300}?showInNewTabLauncher[=!]==!1`);
export const LAUNCHER_NEEDLE = 'showInNewTabLauncher';
// The file tree's context menu (mod-surfaces.md §3.5, E8.7): one pure builder makes the items of a file or folder row in the Files and the
// Changes trees: `function F({isLoadingOpenTargets, onAddToChat, onCopyPath, onOpenInTarget, onSaveAs, primaryTarget, targetPath, visibleTargets}){…}`.
export const FILE_MENU_RE = rx(String.raw`function(?: @name@)?\(\{isLoadingOpenTargets:@a@=!1,onAddToChat:@b@,onCopyPath:@c@,onOpenInTarget:@d@,onSaveAs:@e@,primaryTarget:@f@,targetPath:@g@,visibleTargets:@h@\}\)\{if\((?:\k<g>==null|null==\k<g>)\)return\[\]`);
export const FILE_MENU_NEEDLE = 'isLoadingOpenTargets:';
// A file referenced anywhere else (E8.7b): a file chip, a file link in a message, a file tab, an attachment: one pure builder makes its
// menu, given the reference (`function F(scope,{artifactNavigationTarget, …, cwd, …, openMode, openInSidePanel=!1, path},githubUrl=null){…}`).
export const WORKSPACE_FILE_MENU_RE = rx(String.raw`function @name@\(@e@,\{artifactNavigationTarget:@t@,attachmentPreviewOrigin:@n@,column:@r@,(?:conversationId:@cid@,)?cwd:@i@,endLine:@a@,hostId:@o@,isAttachmentPreview:@s@,line:@c@,onOpenTargetSelected:@l@,openMode:@u@,openInSidePanel:@d@=!1,path:@f@\},@p@=null\)\{`);
export const WORKSPACE_FILE_MENU_NEEDLE = 'artifactNavigationTarget:';
// A panel tab's menu (E8.7b): one builder makes the items of a tab of the side and bottom panels' strips (its right-click and its menu):
// `function F({scope,controller,onBeginRename,tab,placement=`tab-strip`,isSourceCurrent=()=>!0}){…}` (a list, or a promise of one).
export const TAB_MENU_RE = rx(String.raw`function(?: @name@)?\(\{scope:@e@,controller:@t@,onBeginRename:@n@,tab:@r@,placement:@i@=\`tab-strip\`,isSourceCurrent:@a@=\(\)=>!0\}\)\{`);
export const TAB_MENU_NEEDLE = 'isSourceCurrent:';
// Message content (mod-surfaces.md §3.3, E8.8): every markdown site of the app builds its element maps with two module-private builders,
// the components (its link and code: `function F({allowWideBlocks, conversationId, cwd, externalLinkAppearance, …}){return{a:…,code:…}}`)
// and the default directives (`function F({conversationId, cwd, enableInlineDil, …}){return{…}}`); the caller's own entries win over them.
export const MD_COMPONENTS_RE = rx(String.raw`function @name@\(\{allowWideBlocks:@a@,conversationId:@b@,cwd:@c@,externalLinkAppearance:@d@,[^()]{0,600}?\}\)\{return\{a:`);
export const MD_COMPONENTS_NEEDLE = '{allowWideBlocks:';
export const MD_DIRECTIVES_RE = rx(String.raw`function @name@\(\{conversationId:@a@,cwd:@b@,enableInlineDil:@c@,[^()]{0,400}?\}\)\{return\{`);
export const MD_DIRECTIVES_NEEDLE = 'enableInlineDil:';
/** Main process, second shape (22943): the host is created inline as the AppView factory's argument, and `registerAppView` is guarded by `null!=ctx&&`. */
export const APP_HOST_INLINE_RE = rx(String.raw`@view@=@make@\(@port@,@ctx@\?\.createAppHost\(@ev@\.sender\)\);null!=\k<ctx>&&\k<ctx>\.registerAppView\(\k<ev>\.sender,\k<view>\)`);
/** Main process, third shape (25679): the host has its own binding, a close listener for the port comes between, then the AppView is made in its own
 *  declaration and registered behind `null!=ctx&&`. */
export const APP_HOST_SPLIT_RE = rx(String.raw`@host@=@ctx@\?\.createAppHost\(@ev@\.sender\),[^{}]{0,300}?;let @view@=@make@\(@port@,\k<host>\);null!=\k<ctx>&&\k<ctx>\.registerAppView\(\k<ev>\.sender,\k<view>\)`);
/** Main process: the AppHost created for a window's sender and the AppView registered for it. */
export const APP_HOST_RE = rx(String.raw`@host@=@ctx@\?\.createAppHost\(@ev@\.sender\),@view@=@make@\(@port@,\k<host>\);\k<ctx>\?\.registerAppView\(\k<ev>\.sender,\k<view>\)`);

// ---------------------------------------------------------------------------------------------- structure helpers
/** End (exclusive) of the call chain `.a(...).b(...)` that starts at `from`; `from` itself when there is none, -1 when unbalanced. */
export function chainEnd(text, from) {
  let i = from;
  for (;;) {
    const m = new RegExp(`^\\.${ID}\\(`).exec(text.slice(i, i + 96));
    if (!m) return i;
    const close = matchClose(text, i + m[0].length - 1);
    if (close < 0) return -1;
    i = close + 1;
  }
}

const occurrences = (text, needle) => { let n = 0; for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) n++; return n; };
const matches = (text, re) => [...text.matchAll(re)];
const role = (file) => fileStem(file);
const LOCALE_CHUNK = /\/(?:[a-z]{2,3}(?:-[A-Za-z0-9]{2,4})?)-[0-9a-f]{12}\.js$/;
const SOURCEMAP_RE = /\/\/# sourceMappingURL=[^\n]+\.js\.map/g;

// ---------------------------------------------------------------------------------------------- renderer corpus
/**
 * The renderer chunks of a source, searched by content: one pass over every chunk for all the needles the derivers use, and the text kept only
 * for chunks that hold one. Chunk names carry a content hash and move between builds, so no deriver looks anything up by name.
 */
class Corpus {
  constructor(source, needles) {
    this.source = source;
    // Per-language message catalogs are large data files with no code to patch: skipped by their name and size (`xx-YY-<hash>.js`, > 300 KB).
    this.files = source.list('webview/assets/').filter((p) => p.endsWith('.js') && !(LOCALE_CHUNK.test(p) && source.size(p) > 300_000));
    this.needles = [...new Set(needles.flatMap(spellings))];
    this.hits = null;
    this.texts = new Map();
  }
  scan() {
    if (this.hits) return;
    this.hits = new Map(this.needles.map((n) => [n, []]));
    for (const file of this.files) {
      const text = this.source.read(file);
      let kept = false;
      for (const n of this.needles) {
        const count = occurrences(text, n);
        if (count) { this.hits.get(n).push({ file, count }); kept = true; }
      }
      if (kept) this.texts.set(file, text);
    }
  }
  /** [{file, count}] of the chunks that contain `needle` (one of the registered needles) in any of its spellings. */
  find(needle) {
    this.scan();
    if (!this.hits.has(needle)) throw new Error(`seams: needle ${JSON.stringify(needle)} is not registered`);
    const all = spellings(needle);
    if (all.length === 1) return this.hits.get(needle);
    const by = new Map();
    for (const n of all) for (const h of this.hits.get(n)) by.set(h.file, (by.get(h.file) ?? 0) + h.count);
    return [...by].map(([file, count]) => ({ file, count }));
  }
  text(file) {
    this.scan();
    if (!this.texts.has(file)) this.texts.set(file, this.source.read(file));
    return this.texts.get(file);
  }
  /** The module factories of an rspack chunk (rspack.mjs), null for a chunk of a Vite build; read once per chunk. */
  modules(file) {
    if (!this.mods) this.mods = new Map();
    if (!this.mods.has(file)) this.mods.set(file, rspackModules(this.text(file)));
    return this.mods.get(file);
  }
  /** True when the renderer is rspack output (25679 on): its chunks are `<id>.<hash>.js` module maps. Read from one chunk. */
  get rspack() {
    if (this.isRspack === undefined) { const f = this.files.find((p) => /\/\d+\.[0-9a-f]{10}\.js$/.test(p)); this.isRspack = !!f && isRspackChunk(this.source.read(f).slice(0, 400)); }
    return this.isRspack;
  }
  /** The rspack module that holds `index` in `file`, or null (a Vite chunk, or outside every module). */
  moduleAt(file, index) {
    const mods = this.modules(file);
    return mods ? moduleAt(mods, index) : null;
  }
}

// ---------------------------------------------------------------------------------------------- lazy initialisers
// rolldown wraps a module body as `var X;function init(){return(init=esm((()=>{X=...})))()}`: a module-level `var` is assigned inside the
// initialiser, so a reference to it goes through `(init(),X)`. INIT_RE finds the initialisers; a body span is computed on demand with the regex-aware scanner (scan.mjs).
const INIT_RE = new RegExp(`function (${ID})\\(\\)\\{return\\(\\1=${ID}\\(\\(\\(\\)=>\\{`, 'g');
class Inits {
  constructor(text) {
    this.text = text; this.cache = new Map();
    // the initialisers in source order; a body's end is found (and kept) only when a lookup needs it
    this.list = [...text.matchAll(INIT_RE)].map((m) => ({ name: m[1], start: m.index, bodyOpen: m.index + m[0].length - 1, bodyClose: undefined }));
  }
  close(f) { if (f.bodyClose === undefined) f.bodyClose = matchClose(this.text, f.bodyOpen); return f.bodyClose; }
  /** The initialiser whose body holds `pos` (the nearest one that starts before it, if its body reaches), or null. */
  around(pos) {
    let lo = 0; let hi = this.list.length - 1; let best = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (this.list[mid].bodyOpen < pos) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    if (best < 0) return null;
    const f = this.list[best];
    return this.close(f) > pos ? f : null;
  }
  /** The first initialiser that starts after `pos`, or null. */
  after(pos) {
    let lo = 0; let hi = this.list.length - 1; let best = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (this.list[mid].start > pos) { best = this.list[mid]; hi = mid - 1; } else lo = mid + 1; }
    return best;
  }
  /** The one initialiser that assigns the module-level variable `name` (`name=` at statement level inside an initialiser body); null when none. */
  ofVar(name) {
    if (this.cache.has(name)) return this.cache.get(name);
    const owners = new Set(); const t = this.text; const needle = `${name}=`;
    for (let i = t.indexOf(needle); i >= 0; i = t.indexOf(needle, i + 1)) {
      if (/[\w$.]/.test(t[i - 1] ?? '') || t[i + needle.length] === '=' || t[i + needle.length] === '>') continue;
      const f = this.around(i);
      if (f) owners.add(f.name);
    }
    const r = owners.size === 1 ? [...owners][0] : null;
    this.cache.set(name, r);
    return r;
  }
}

/** `(i1(),i2(),expr)`: the initialisers to run before `expr` is read. */
const guarded = (inits, expr) => {
  const names = [...new Set(inits.filter(Boolean))];
  return names.length ? `(${names.map((n) => `${n}()`).join(',')},${expr})` : expr;
};
/** Object literal source: `[key, expr]` is a value member, `[key, expr, true]` a getter that reads `expr` at access time. */
const objectOf = (members) => `{${members.map(([k, v, live]) => (live ? `get ${k}(){return ${v}}` : `${k}:${v}`)).join(',')}}`;

// ---------------------------------------------------------------------------------------------- exposures
/**
 * Each exposure: `key`, the `needle` that finds its chunk(s), and `locate(text, ctx)` → hits `[{ expr }]`. Exactly one hit across all chunks that
 * hold the needle, or the key is missing (never a pick among several). `ctx.inits` is the chunk's Inits. An expression is built from names the
 * regexes captured (never typed in), and reads the app's objects through `get` members so that a module-level `var` is read after its initialiser.
 *
 * The exports API (ABI 1), values of `globalThis.__codexmods.exports[key]`:
 *   appShell           the app-shell namespace { Root, Header, HeaderAction, HeaderContextMenuItem, PageBanner, ..., DetailPanelOutlet }
 *   headerSlots        { center, left, right, main, thread, threadSummary }: the header action slots
 *   tabRegistry        { register(kind, Component, options) → tabType, registry: Map<kind, tabType> }
 *   panelControllers   { openTab(scope, tabType, options), right, bottom }
 *   routeScopes        the component that provides a chat's Thread and Route scopes from {route, children}; conversationTab: the app's lazy host of a second chat ({conversationId, hostId}), with `prefetch`
 *   ScopeProvider      the scope's Provider ({scope, value, children}); composerScopeValue(conversation, placement, routeConversation): a composer scope's value; threadView: the thread view (a lazy chunk's)
 *   PendingRequestPanel the app's panel of a chat's request ({conversationId, hostId, cwd, pendingRequest, onSubmitLocalFollowup}); pendingRequest: an AppScope atom of a chat's request, by its id
 *   hostClient         (scope, hostId) -> the app's client of that host: activateThreadSummary(id, {addToRecent}), ensureConversationFirstPage(id)
 *   layoutSource       { wrap(scope, source, fn), counter, source }: who changed the workspace's layout: the app's wrapper, its counter (moved by every source but `restore`) and the source now
 *   workspaceState     { mode, restored, ready, bottomOpen, tabsOpen }: a chat's workspace: its effective mode, the marks of its restore from its checkpoint, what says its panels are open
 *   workspaceLayout    { setFull(scope, full, opts), setPanel(scope, open, opts), activeTab, preference }: the app's guarded full-width setter (refuses a tab
 *                      kind with allowFullWidth: false) and the side panel's open setter, over the chat's scope
 *   sidebarOrderState  { prefs, pinnedSortMode, projectOrder }: the app's effective atoms that tell whether the user arranged a sidebar list (the
 *                      sort preferences, the pinned list's mode, the project groups' dragged order); read only
 *   atoms              { external(scope, read, subscribe) }: the app's atom factory for a value a function gives (the framework's epochs)
 *   launcherOrder      { table }: the new-tab launcher's order of the app's actions in a git project (written by the framework's rules)
 *   sidebarGroupState  { sections }: the atom holding the user's saved sidebar group order (sectionOrder), read only
 *   SidebarSortable    the sortable container the conversations sidebar's groups are drawn in (dnd-kit's SortableContext)
 *   sidebarFooter      { usageAlert, checklist, financeChecklist, announcement, updateBanner, invite, stack, row, account, update }: the
 *                      sidebar footer's banners' and buttons' components
 *   navigationShell    the frame's context (a React context): its widths as motion values, its flags; the frame host narrows it
 *   windowRegions      { sidebarWidth, clampSidebar(width, shellWidth), setBottom(scope, open, opts) }: the sidebar's live width (an AppScope
 *                      atom: the window's own, never the stored key), the app's clamp of it, and the bottom panel's open setter (the chat's scope)
 *   modal              { open(scope, Component, props, { blocksOtherModals }), close(scope, Component), closeAll(scope), isOpen(scope, Component), atom }
 *   commandStack       { register(id, handler, { isActive, priority }) → unregister, run(id, event, origin), runKeyboard, runner, hasDefault, defaultHandler, stack: Map, defaults: Map }
 *   commandRegistered  { useHandler, addRegistered, removeRegistered, atom }
 *   slashRegistry      { appAtom, composerAtom, openCountAtom, mergedAtom, sortItems }
 *   slashHooks         { useComposerItem, useComposerItems, useAppItem, registerCore }
 *   routes             the route table (the array the router reads on every render)
 *   panelSlots         { publish, pairs: [[component, atom], ...] }: the panel slot publisher components and the atoms they write
 *   shellSignals       { Signal, header: { component, children, desktopPlacement, contentFade, divider, separator }, pageBanner: { component, signal } }
 *   AppScope, ComposerScope, RouteScope, ThreadScope   the scope definitions
 *   toast              { get() → the toast API, atom }
 *   bus                the message bus class (`bus.getInstance()`)
 *   react              the React module
 *   useScope           the hook that reads a scope's context chain
 *   composerBanners    { select, candidate, List, order: banner candidates in priority order }
 *   reactDom           the react-dom module with its client (createPortal, flushSync, createRoot, …)
 *   Button, Switch, TextField, Menu, Dialog, SettingsSection, SettingsRow, Tooltip, Icon   the app's own design-system components (v1's
 *                      ComponentNames; the app has no standalone Select); MenuParts { Trigger, Content, Item, Separator, … } and
 *                      DialogParts { Header, Body, Footer } are their compound parts, SettingsSection carries its own (.Header, .Content, .Footer)
 *   SettingsPageFrame  the frame of a settings page (title, subtitle, action, toolbarActions, stickyControls, footer, density, children)
 *   SettingsCard       the card a settings section's rows sit in ({ children, variant, dividers })
 *   NavItem, NavGroup  an entry of a navigation list and its group (the settings navigation; docs/design/systems.md S15)
 *   ComposerControllerContext   the context a composer's controller is given in (getText, setText, insertTextAtSelection, insertMention,
 *                      restoreDocument, clearSuggestion, view, ...; E8.3b): null outside a composer
 *   ComposerDropdown   a composer picker: its trigger, label and menu (value, children, menuOpen, onOpenChange, tooltipContent, ...;
 *                      the mods' thread-scope settings in the composer, docs/design/systems.md E3)
 */
const hit = (index, expr) => ({ index, expr });
const only = (re, text) => matches(text, re);

const scopeExposure = (name) => ({
  key: name,
  needle: `\`${name}\``,
  locate(text, { inits }) {
    return only(rx(String.raw`@name@=(?:${ID}|\(0,(?:${ID}|${ID}\(\`[\w$]+\`\))\.${ID}\))\(\`${name}\`(?:\)|,\{key:)`), text).map((m) => hit(m.index, guarded([inits.ofVar(m.groups.name) ?? inits.around(m.index)?.name], m.groups.name)));
  },
});

/** A function declaration found by `re` (its name in the `name` group), read after the first initialiser that follows it (its module's own, which
 *  readies what the function reads). */
const fnExposure = (key, needle, re) => ({
  key, needle,
  locate: (text, { inits }) => only(re, text).map((m) => {
    const close = matchClose(text, text.indexOf('{', m.index + m[0].indexOf('(')));
    return hit(m.index, guarded([inits.after(close > 0 ? close : m.index)?.name], m.groups.name));
  }),
});
/** A module-level variable assigned where `re` matches (its name in the `name` group), read after the initialiser that assigns it. */
const varExposure = (key, needle, re, expr = (g) => g.name) => ({
  key, needle,
  locate: (text, { inits }) => only(re, text).map((m) => hit(m.index, guarded([inits.ofVar(m.groups.name) ?? inits.around(m.index)?.name], expr(m.groups)))),
});
/** The CJS wrapper (`X=cjs((e=>{`) that holds the one `needle` of a module, with the alias that re-exports it (`A=cjs(((e,t)=>{…t.exports=X()}))`). */
function cjsWrapper(text, needle) {
  if (occurrences(text, needle) !== 1) return null;
  const at = text.indexOf(needle);
  let last = null;
  for (const m of matches(text.slice(0, at), rx(String.raw`(?:^|[,;\s])@wrap@=@cjs@\(\(\(?e\)?=>\{`))) last = m;
  if (!last) return null;
  const alias = new RegExp(`(?:^|[,;\\s])${ID}=${esc(last.groups.cjs)}\\(\\(\\(e,t\\)=>\\{function (${ID})\\(\\)\\{[^]{0,300}?\\}\\1\\(\\),t\\.exports=${esc(last.groups.wrap)}\\(\\)\\}\\)\\)`).exec(text);
  return alias ? last.groups.wrap : null;
}

/**
 * The names `name` (a top-level function of `file`) goes by in the other chunks that import it, among the chunks holding `needle`:
 * the chunk's export list names it (`export{name as x}` or `export{name}`), another chunk imports that (`import{x as y}from"./<file>"`).
 * Rolldown splits a module's users across chunks, so a user of a function is not always where the function is declared.
 */
function importersOf(corpus, file, name, needle) {
  const t = corpus.text(file);
  const exp = t.slice(t.lastIndexOf('export{'));
  const exported = new RegExp(`(?<![\\w$])${esc(name)} as (${ID})(?=[,}])`).exec(exp)?.[1] ?? (new RegExp(`[{,]${esc(name)}(?=[,}])`).test(exp) ? name : null);
  if (!exported) return [];
  const stem = file.split('/').pop();
  const out = [];
  for (const { file: other } of corpus.find(needle)) {
    if (other === file) continue;
    const m = new RegExp(`import\\{[^}]*?(?<![\\w$])${esc(exported)}(?: as (${ID}))?(?=[,}])[^}]*\\}from"\\./${esc(stem)}"`).exec(corpus.text(other));
    if (m) out.push({ file: other, local: m[1] ?? exported });
  }
  return out;
}

/** The modules an rspack module imports: local name -> module id (`var r=n("iRMi"),i=n("zTeN")`). */
const importsOf = (body) => new Map([...body.matchAll(new RegExp(String.raw`(?<![\w$.])(${ID})=${ID}\("([^"]+)"\)`, 'g'))].map((m) => [m[1], m[2]]));

/** An rspack module's exports object (its `t` parameter) as seen from `index`: the first argument of the nearest `n.d(t,{..},{` before it, or null. */
const exportsParam = (text, index) => {
  for (let i = text.lastIndexOf('.d(', index); i >= 0; i = text.lastIndexOf('.d(', i - 1)) {
    const re = new RegExp(String.raw`\.d\((${ID}),\{[^{}]*\},\{`, 'y'); re.lastIndex = i;
    const m = re.exec(text);
    if (m) return m[1];
  }
  return null;
};

/** A name or, on rspack, a module's member (`o.hy`). */
const REF = String.raw`${ID}(?:\.${ID})?`;
/**
 * The expression that reads, inside the rspack module `host`, what `ref` names inside the module `src` (`ref` is a module-local name or a member of
 * one of `src`'s imports): `host`'s own import of the module that holds it (else its require, `n("id")`), then the member that module exports it as. null when
 * the name is not exported. `text` is the chunk, `mods` its modules.
 */
function readFrom(text, mods, host, src, ref) {
  const importsOfMod = (m) => importsOf(text.slice(m.open, m.close));
  let holder; let member;
  const dot = /^([\w$]+)\.([\w$]+)$/.exec(ref);
  if (dot) { holder = mods.find((m) => m.id === importsOfMod(src).get(dot[1])); member = dot[2]; }
  else {
    holder = src;
    if (src === host) return ref;
    const body = text.slice(src.open, src.close); const exp = body.slice(Math.max(0, body.lastIndexOf('.d(')));
    member = new RegExp(String.raw`[{,]([\w$]+):${esc(ref)}(?=[,}])`).exec(exp)?.[1];
  }
  if (!holder || !member) return null;
  if (holder === host) return dot ? `${dot[1]}.${member}` : ref;
  const v = [...importsOfMod(host)].find(([, id]) => id === holder.id)?.[0];
  // a module the host does not import (it is in the chunk, so loaded): through the host's own require
  return v ? `${v}.${member}` : `${host.params.split(',')[2]}(${JSON.stringify(holder.id)}).${member}`;
}

// ---- NEW shared helpers (rspack) -----------------------------------------------------------------------------------------------------------
/** The rspack module holding `index`, with the names of its parameters: `{ id, exports, require }` (`exports` is the 2nd factory parameter, `require` the 3rd), or null (Vite). */
const moduleNames = (corpus, file, index) => { const m = corpus?.moduleAt(file, index); if (!m) return null; const p = m.params.split(','); return { id: m.id, mod: m, exports: p[1], require: p[2] }; };
/** The export key and span of the function expression `key:function(…){…}` (an `i.d(t,{},{key:function…})` member) that holds `idx`, or null. */
function exportedFn(text, idx) {
  let from = idx;
  for (let tries = 0; tries < 80; tries++) {
    const p = text.lastIndexOf(':function(', from);
    if (p < 0) return null;
    from = p - 1;
    const m = new RegExp(`[{,](${ID})$`).exec(text.slice(Math.max(0, p - 40), p));
    if (!m) continue;
    const pc = matchClose(text, p + ':function'.length);
    if (pc < 0) continue;
    const b = text.indexOf('{', pc);
    const e = b < 0 ? -1 : matchClose(text, b);
    if (e > idx) return { name: m[1], start: p + 1, end: e, exported: true };
  }
  return null;
}
/** A function (named declaration or exported function expression) that holds `idx`. */
const fnAround = (text, idx) => { const f = enclosingFunction(text, idx); return f ? { ...f, exported: false } : exportedFn(text, idx); };
const SLASH_OLD = String.raw`@app@=@cs@\(@appScope@,\[\]\),@comp@=\k<cs>\(@compScope@,\[\]\),@cnt@=\k<cs>\(\k<compScope>,0\),@merged@=@Y@\(\k<compScope>,\(\{get:@g@\}\)=>@sort@\(\(0,@ld@\.default\)\(\[\.\.\.\k<g>\(\k<comp>\),\.\.\.\k<g>\(\k<app>\)\],@x@=>\k<x>\.id\)\)\)`;
const SLASH_NEW = String.raw`@app@=\(0,@cs@\.${'[\\w$]+'}\)\(${ID}\.${ID},\[\]\),@comp@=\(0,\k<cs>\.[\w$]+\)\((?<compScope>${ID}\.${ID}),\[\]\),@cnt@=\(0,\k<cs>\.[\w$]+\)\(\k<compScope>,0\),@merged@=\(0,\k<cs>\.[\w$]+\)\(\k<compScope>,\(\{get:@g@\}\)=>@sort@\(@ld@\(\)\(\[\.\.\.\k<g>\(\k<comp>\),\.\.\.\k<g>\(\k<app>\)\],@x@=>\k<x>\.id\)\)\)`;

// rspack (25679): an app object that is an anonymous export of its module, read through the module's exports parameter, and the branches of
// the locators whose objects are spread over several exports or modules
/** An exported function expression (`name:function(e){…}` in `n.d(t,{},{…})`) found by `re`, read as the module's `<exports param>.<name>` (rspack). */
const exportedFnExposure = (key, needle, re) => ({
  key, needle,
  locate: (text, { corpus, file }) => only(re, text).flatMap((m) => { const t = moduleNames(corpus, file, m.index)?.exports; return t ? [hit(m.index, `${t}.${m.groups.name}`)] : []; }),
});
/** A function that is a declaration on Vite builds (`re`, as fnExposure) and an exported function expression on rspack (`reExported`). */
const fnOrExported = (key, needle, re, reExported) => {
  const plain = fnExposure(key, needle, re); const exported = exportedFnExposure(key, needle, reExported);
  return { key, needle, locate: (text, ctx) => [...plain.locate(text, ctx), ...exported.locate(text, ctx)] };
};
// ---- helpers (new, in seams.mjs near fnExposure)
const exportsOf = (corpus, file, index) => corpus.moduleAt(file, index)?.params.split(',')[1];
// ---- sidebarShowAll
const sidebarShowAllRspack = (text, { file, corpus }) => {
    const rspack = only(rx(String.raw`@set@:function\(@e@,@t@,@n@\)\{let @r@=\k<e>\.get\(@atom@\);if\(\k<n>===\((?:\k<r>\[\k<t>\]===!0|!0===\k<r>\[\k<t>\])\)\)return;if\(\k<n>\)return void \k<e>\.set\(\k<atom>,\{\.\.\.\k<r>,\[\k<t>\]:!0\}\);let @i@=\{\.\.\.\k<r>\};delete \k<i>\[\k<t>\],\k<e>\.set\(\k<atom>,\k<i>\)\}`), text);
    const keyedAnywhere = (modId, set) => corpus.find('`project:${').some(({ file: f }) => {
      const t = corpus.text(f);
      return only(new RegExp(String.raw`(${ID})=\`project:\$\{${ID}\.projectId\}\``, 'g'), t).some((k) => {
        const mod = corpus.moduleAt(f, k.index); if (!mod) return false;
        const body = t.slice(mod.open, mod.close);
        return only(new RegExp(String.raw`(?:^|[,;{(\s])(${ID})=${ID}\("${esc(modId)}"\)`, 'g'), body)
          .some((ns) => new RegExp(String.raw`\(0,${esc(ns[1])}\.${esc(set)}\)\(${ID},${esc(k[1])},`).test(body));
      });
    });
    return rspack
      .filter((m) => { const mod = corpus.moduleAt(file, m.index); return mod && keyedAnywhere(mod.id, m.groups.set); })
      .map((m) => hit(m.index, objectOf([['set', `${exportsOf(corpus, file, m.index)}.${m.groups.set}`], ['atom', m.groups.atom, true]])));
  };
// ---- transcriptReveal (rspack branch)
const transcriptRevealRspack = (text, { file, corpus }) => {
  const reg = only(rx(String.raw`@register@:function\(@s@,@c@,@h@\)\{return \k<s>\.set\(@atom@,\k<c>,\k<h>\),\(\)=>\{\k<s>\.get\(\k<atom>,\k<c>\)===\k<h>&&\k<s>\.set\(\k<atom>,\k<c>,null\)\}\}`), text);
  return reg.filter((m) => only(rx(String.raw`:function\(@s2@,@c2@,@a@,@b@\)\{return \k<s2>\.get\(${esc(m.groups.atom)},\k<c2>\)\?\.revealResponseTextAnnotation\(\k<a>,\k<b>\)\?\?Promise\.resolve\(\)\}`), text).length === 1)
    .map((m) => hit(m.index, objectOf([['atom', m.groups.atom, true], ['register', `${exportsOf(corpus, file, m.index)}.${m.groups.register}`]])));
};
// ---- terminalManager (rspack branch): the singleton is `X=new class{…}`
const terminalManagerRspack = (text) => {
  const out = [];
  for (const m of only(rx(String.raw`@inst@=new class\{hostService=null;listeners=new Map;renderers=new Map;(?:${ID}=new Map;)*?lastRenderedOutputBySessionId=new Map;`), text)) {
    const open = m.index + m[0].indexOf('{');
    const end = matchClose(text, open);
    if (end > 0 && text.slice(open, end).includes('getOrCreateRenderer(')) out.push(hit(m.index, m.groups.inst));
  }
  return out;
};
// ---- threadFind (rspack branch)
const threadFindRspack = (text, { file, corpus }) => {
  const one = (re) => { const ms = only(re, text); return ms.length === 1 ? ms[0] : null; };
  const open = one(rx(String.raw`function @name@\(@e@,\{selectDefaultTarget:@t@=!0\}=\{\}\)\{let @n@=\k<e>\.get\(@target@\)\.orchestrationId;\k<t>&&null!=\k<n>&&@sel@\(\k<e>,\k<n>\),\k<e>\.set\(@open@,!0\)\}`));
  const close = one(rx(String.raw`function @name@\(@e@\)\{\`file\`===\k<e>\.get\(@domain@\)&&\k<e>\.get\(@ctl@\)\?\.focus\(\),@clear@\(\k<e>\),\k<e>\.set\(@open@,!1\),\k<e>\.set\(@query@,\`\`\),\k<e>\.set\(@results@,null\),\k<e>\.set\(@pending@,!1\),\k<e>\.set\(@active@,null\)\}`));
  const setDomain = one(rx(String.raw`function @name@\(@e@,@t@\)\{@clear@\(\k<e>\),\k<e>\.set\(@domain@,\k<t>\),\k<e>\.set\(@results@,null\),\k<e>\.set\(@pending@,!1\),\k<e>\.set\(@active@,null\)\}`));
  // an exported anonymous function (`aM:function(e,t){…}`), read as `<exports>.aM`
  const setQuery = one(rx(String.raw`@name@:function\(@e@,@t@\)\{if\(0===\k<t>\.trim\(\)\.length\)\{@clear@\(\k<e>\),\k<e>\.set\(@query@,\k<t>\),\k<e>\.set\(@results@,null\),\k<e>\.set\(@pending@,!1\),\k<e>\.set\(@active@,null\);return\}\k<e>\.set\(\k<query>,\k<t>\),\k<e>\.set\(\k<pending>,!0\)\}`));
  const step = (dir) => one(rx(String.raw`function @name@\(@e@\)\{if\(\`file\`===\k<e>\.get\(@domain@\)\)return void @m@\(\k<e>,\`${dir}\`\);`));
  const next = step('next'), previous = step('previous');
  if (!open || !close || !setDomain || !setQuery || !next || !previous) return [];
  const g = (m) => m.groups;
  if (g(close).open !== g(open).open || g(close).domain !== g(setDomain).domain || g(close).query !== g(setQuery).query
    || g(close).results !== g(setDomain).results || g(close).active !== g(setDomain).active) return [];
  const exp = exportsOf(corpus, file, setQuery.index);
  return [hit(open.index, objectOf([['open', g(open).name], ['close', g(close).name], ['setDomain', g(setDomain).name],
    ['setQuery', `${exp}.${g(setQuery).name}`], ['next', g(next).name], ['previous', g(previous).name],
    ['atoms', objectOf([['open', g(open).open, true], ['query', g(setQuery).query, true], ['domain', g(setDomain).domain, true], ['results', g(close).results, true], ['active', g(close).active, true]]), false]]))];
};
// ---- panelWidth (rspack branch: shape 3)
const panelWidthRspack = (text, { inits, file, corpus }) => {
  const one = (re) => { const ms = only(re, text); return ms.length === 1 ? ms[0] : null; };
  const config = one(rx(String.raw`@name@=(?:@W@|\(0,@o@\.@un@\))\([\w$.]+,\(\{get:@e@\}\)=>\{let @t@=\k<e>\([\w$.]+\.activeTab\$\);return \k<e>\([\w$.]+\)\?\?\((?:\k<t>==null|null==\k<t>)\?\k<e>\([\w$.]+\):\k<t>\.tabType\.paneWidth\?\.\(\k<t>\.props\)\)\?\?\k<e>\([\w$.]+\)\}\)`));
  if (!config) return [];
  const unified = one(new RegExp(String.raw`(${ID})=(${ID}|\(0,${ID}\.${ID}\))\(${esc(config.groups.name)}\),(${ID})=\2\((?<atom>${ID}(?:\.${ID})?)\),[^]{0,600}?(${ID})=(?:\3==null\?[\`"']regular[\`"']:[\`"']unified[\`"']|null!=\3\?[\`"']unified[\`"']:[\`"']regular[\`"'])`, 'g'));
  if (!unified) return [];
  // the helpers are another module's exports, called through its namespace in the panel's drag handlers
  const call = one(rx(String.raw`\(0,@ns@\.@name@\)\(\{mainContentWidth:@total@\.get\(\),storageKey:@cfg@\.storageKey,width:@w@,widthMode:@mode@\}\)`));
  if (!call) return [];
  const set = one(new RegExp(String.raw`${ID}\.set\(\(0,${esc(call.groups.ns)}\.(?<toRatio>${ID})\)\(${ID},${ID},${esc(call.groups.mode)}\)\)`, 'g'));
  if (!set || Math.abs(set.index - call.index) > 3000) return [];
  const id = (m) => corpus.moduleAt(file, m.index)?.id;
  if (new Set([config, unified, call, set].map(id)).size !== 1) return [];
  const ns = call.groups.ns;
  return [hit(call.index, guarded([inits.ofVar(config.groups.name) ?? inits.around(config.index)?.name],
    objectOf([['toRatio', `${ns}.${set.groups.toRatio}`], ['persist', `${ns}.${call.groups.name}`], ['config', config.groups.name, true], ['unified', unified.groups.atom, true]])))];
};
// ---- sidebarOrderState (rspack branch)
const CALL = String.raw`\(0,[\w$]+(?:\("[\w$]+"\))?\.[\w$]+\)`;
const sidebarOrderStateRspack = (text, { file, corpus }) => {
  const one = (re) => { const ms = only(re, text); return ms.length === 1 ? ms[0] : null; };
  const pinned = one(rx(String.raw`@persist@=(?<X>${CALL})\(\`pinned-sidebar-sort-mode-v1\`,\`manual\`\),@atom@=\(0,@r@\.@un@\)\([\w$]+\.[\w$]+,\(\{get:@e@\}\)=>\{let @t@=\k<e>\(\k<persist>\);return(?:\`priority\`===\k<t>\?\`updated_at\`:\k<t>\?\?\`manual\`)\}\)`));
  if (!pinned) return [];
  const host = corpus.moduleAt(file, pinned.index);
  const [, exp, req] = host.params.split(',');
  // the export name of a module-level atom: `n.d(t,{},{name:atom})` or `{name:()=>atom}`
  const exported = (t, mod, local) => new RegExp(String.raw`[{,](${ID}):(?:\(\)=>)?${esc(local)}(?=[,}])`).exec(t.slice(mod.open, mod.close))?.[1];
  const hostName = exported(text, host, pinned.groups.atom);
  // the other two atoms are exports of two other modules (found by their own persisted keys), read through the host's own require
  const via = (needle, re, pick) => {
    const found = new Map();
    for (const { file: f } of corpus.find(needle)) {
      const t = corpus.text(f);
      for (const m of only(re, t)) { const mod = corpus.moduleAt(f, m.index); const name = mod && exported(t, mod, m.groups[pick]); if (name) found.set(mod.id, `${req}(${JSON.stringify(mod.id)}).${name}`); }
    }
    return found.size === 1 ? [...found.values()][0] : null;
  };
  const prefs = via('flat-project-sidebar-preferences-v1', rx(String.raw`@persist@=(?<X>${CALL})\(\`flat-project-sidebar-preferences-v1\`,@dflt@\),@legacy@=\k<X>\(\`codex-sidebar-sort-mode-v1\`,void 0\),@atom@=\(0,@r@\.@un@\)\([\w$]+\.[\w$]+,\(\{get:@e@\}\)=>\{let @t@=@norm@\(\k<e>\(\k<persist>\)\?\?\(0,[\w$]+\.[\w$]+\)\(\`flat-project-sidebar-preferences-v1\`,\k<dflt>\),`), 'atom');
  const order = via('unified-sidebar-chat-order-v1', rx(String.raw`@chatP@=(?<X>${CALL})\(\`unified-sidebar-chat-order-v1\`,@d1@\),@projP@=\k<X>\(\`unified-sidebar-project-order-v1\`,@d2@\),[^]{0,500}?@chat@=\(0,@r@\.@un@\)\([\w$]+\.[\w$]+,\(\{get:@e@\}\)=>\k<e>\(\k<chatP>\)\?\?\k<d1>\),@pinned@=\(0,\k<r>\.\k<un>\)\([\w$]+\.[\w$]+,\(\{get:\k<e>\}\)=>\{[^]{0,260}?\`unified-sidebar-pinned-order-v1\`[^]{0,1400}?\}\),@proj@=\(0,\k<r>\.\k<un>\)\([\w$]+\.[\w$]+,\(\{get:\k<e>\}\)=>\k<e>\(\k<projP>\)\?\?\k<d2>\)`), 'proj');
  if (!hostName || !prefs || !order) return [];
  return [hit(pinned.index, objectOf([['prefs', prefs, true], ['pinnedSortMode', `${exp}.${hostName}`, true], ['projectOrder', order, true]]))];
};

/** A call of a scope helper: a local (`C(e)`, rolldown) or another module's export (`(0,X.y)(e)`, rspack). */
const SCOPE_CALL = `(?:${ID}|\\(0,${ID}\\.${ID}\\))`;

/** The app shell's members its locator requires: wherever the namespace is located, these are in it. */
const APP_SHELL_GUARANTEES = Object.freeze(['HeaderAction', 'HeaderToolbar', 'DetailPanelOutlet']);
export const EXPOSURES = [
  {
    key: 'appShell',
    needle: 'HeaderContextMenuItem:',
    // members the literal must hold to be this namespace: wherever it is located, these are there (the feature log reads them)
    guarantees: APP_SHELL_GUARANTEES,
    locate(text, { inits }) {
      // The namespace object, found by its un-minified member names: the literal around the one `HeaderContextMenuItem:`.
      const at = text.indexOf('HeaderContextMenuItem:');
      if (occurrences(text, 'HeaderContextMenuItem:') !== 1) return [];
      for (let j = text.lastIndexOf('={', at), tries = 0; j >= 0 && tries < 12; j = text.lastIndexOf('={', j - 1), tries++) {
        const close = matchClose(text, j + 1);
        if (close < at) continue;
        const lit = text.slice(j + 1, close + 1);
        const name = new RegExp(`(${ID})$`).exec(text.slice(Math.max(0, j - 64), j))?.[1];
        if (name && APP_SHELL_GUARANTEES.every((k) => lit.includes(`${k}:`))) return [hit(j, guarded([inits.ofVar(name) ?? inits.around(j)?.name], name))];
      }
      return [];
    },
  },
  {
    key: 'headerSlots',
    needle: 'threadSummary:',
    // rolldown binds the literal to a variable; rspack writes it inline as an export (`pe:{center:..}`): the same slots, named as an object
    locate: (text, { inits }) => only(rx(String.raw`(?:@name@=|[,{]@key@:)\{center:@a@,left:@b@,right:@c@,main:@d@,thread:@e@,threadSummary:@f@\}`), text)
      .map((m) => { const g = m.groups; return hit(m.index, g.name ? guarded([inits.ofVar(g.name) ?? inits.around(m.index)?.name], g.name) : objectOf([['center', g.a], ['left', g.b], ['right', g.c], ['main', g.d], ['thread', g.e], ['threadSummary', g.f]].map(([k, v]) => [k, v, true]))); }),
  },
  {
    key: 'tabRegistry',
    needle: '.externalDrop??',
    // rolldown: a declared function; rspack: an export written `n.d(t,{},{v:function(..){..}})`, read as `t.v` (the module's exports object)
    locate: (text, { inits }) => only(rx(String.raw`(?:function @fn@|[,{]@exp@:function)\(@a@,@b@,@c@\)\{let @r@=\{\.\.\.\k<c>,externalDrop:\k<c>\.externalDrop\?\?@reg@\.get\(\k<a>\)\?\.externalDrop,(?:${ID}:\k<c>\.${ID}\?\?\k<reg>\.get\(\k<a>\)\?\.${ID},)*Component:\k<b>,dropDestinations:\k<c>\.dropDestinations\?\?@dd@,kind:\k<a>\};return \k<reg>\.set\(\k<a>,\k<r>\),\k<r>\}`), text)
      .map((m) => {
        const g = m.groups; const after = m.index + m[0].length;
        const ex = g.fn ? null : exportsParam(text, m.index);
        if (!g.fn && !ex) return null;
        return hit(m.index, guarded([inits.ofVar(g.reg), inits.after(after)?.name], objectOf([['register', g.fn ?? `${ex}.${g.exp}`], ['registry', g.reg, true]])));
      }).filter(Boolean),
  },
  {
    // the workspace's layout setters (layouts.md D6, WL3): the app's guarded full-width setter (it refuses when the active tab's kind says
    // `allowFullWidth: false`) and the side panel's open setter, located together by the preferred mode both read
    key: 'workspaceLayout',
    needle: 'tabType.allowFullWidth===!1||(',
    locate(text, { inits }) {
      const one = (re) => { const ms = only(re, text); return ms.length === 1 ? ms[0] : null; };
      // a name, or on rspack a module's member (`o.hy`)
      const full = one(rx(String.raw`function @name@\(@e@,@t@,@n@=\{\}\)\{if\(\k<t>&&\k<e>\.get\(@ctl@\.activeTab\$\)\?\.tabType\.allowFullWidth===!1\|\|\(\k<e>\.set\((?<pref>${REF}),\k<t>\?\`full\`:\`split\`\)`));
      if (!full) return [];
      const g = full.groups;
      let setPanel;
      const mods = rspackModules(text);
      if (!mods) {
        // rolldown: the open setter is a function of the same chunk, reading the same preference
        const open = one(new RegExp(String.raw`function (?<name>${ID})\((?<e>${ID}),(?<t>${ID}),(?<n>${ID})=\{\}\)\{\k<t>&&!\k<e>\.get\(${ID}\)&&\k<e>\.set\(${ID},!1\),\k<t>&&\k<e>\.set\(${ID},\k<e>\.get\(${esc(g.pref)}\)===\`full\`\)`.replaceAll('\\`', '[`"\']'), 'g'));
        if (!open) return [];
        setPanel = open.groups.name;
      } else {
        // rspack: the setter is a function of the module the side panel's controller opens it from (`(0,l.mC)(e,!1,..)`, `l = n("gbrq")`), which reads
        // the preference of the same module as this one (`o.hy`, `o = n("QcW8")`); the chunk holds both modules
        const here = moduleAt(mods, full.index);
        if (!here) return [];
        const imports = importsOf(text.slice(here.open, here.close));
        const pm = /^(\w[\w$]*)\.([\w$]+)$/.exec(g.pref);
        const right = one(new RegExp(String.raw`panelId:"right",getPanelOpenSignal:\(\)=>${ID}\.${ID},singleTab:!1,setPanelOpen:\((?<e>${ID}),(?<t>${ID}),${ID}\)=>\{\k<t>\?${ID}\(\k<e>,${ID}\):\(0,(?<v>${ID})\.(?<exp>${ID})\)\(\k<e>,!1,`, 'g'));
        if (!pm || !right || here.id !== moduleAt(mods, right.index)?.id) return [];
        const target = mods.find((m) => m.id === imports.get(right.groups.v));
        if (!target || imports.get(pm[1]) == null) return [];
        const tbody = text.slice(target.open, target.close);
        // in the setter's module the same preference is read through that module's own name for the imported module
        const timports = importsOf(tbody);
        const fn = new RegExp(String.raw`function (?<name>${ID})\((?<e>${ID}),(?<t>${ID}),(?<n>${ID})=\{\}\)\{\k<t>&&!\k<e>\.get\(${ID}\.${ID}\)&&\k<e>\.set\(${ID}\.${ID},!1\),\k<t>&&\k<e>\.set\(${ID}\.${ID},(?<read>[^;]{0,80}?)\);`, 'g');
        const open = [...tbody.matchAll(fn)];
        if (open.length !== 1) return [];
        const rd = new RegExp(String.raw`^(?:${ID}\.get\((?<p>${ID})\.(?<m>${ID})\)===\`full\`|\`full\`===${ID}\.get\((?<p2>${ID})\.(?<m2>${ID})\))$`.replaceAll('\\`', '[`"\']')).exec(open[0].groups.read);
        const rp = rd && (rd.groups.p ?? rd.groups.p2); const rm = rd && (rd.groups.m ?? rd.groups.m2);
        if (!rd || rm !== pm[2] || timports.get(rp) !== imports.get(pm[1])) return [];
        if (!new RegExp(String.raw`[{,]${esc(right.groups.exp)}:${esc(open[0].groups.name)}(?=[,}])`).test(tbody.slice(tbody.lastIndexOf('.d('))) ) return [];
        setPanel = `${right.groups.v}.${right.groups.exp}`;
      }
      return [hit(full.index, guarded([inits.ofVar(g.ctl) ?? inits.around(full.index)?.name], objectOf([['setFull', g.name], ['setPanel', setPanel], ['activeTab', `${g.ctl}.activeTab$`, true], ['preference', g.pref, true]])))];
    },
  },
  {
    // who changed the workspace's layout (layouts.md D11, WL6; scout wl6-layouts.md, finding 1): the app runs every layout interaction through
    // one wrapper, which bumps a counter unless the source is its own restore, and holds the source in an atom for the call
    key: 'layoutSource',
    needle: '`restore`',
    // rolldown: a declared function and a counter atom; rspack: the function is an export (`$:function(e,t,n){..}`, read as `t.$`) and the counter another
    // module's member (`i.bp`)
    locate: (text) => only(rx(String.raw`(?:function @wrap@|[,{]@exp@:function)\(@e@,@t@,@n@\)\{(?:\k<t>!==\`restore\`|\`restore\`!==\k<t>)&&\k<e>\.set\((?<counter>${ID}(?:\.${ID})?),@x@=>\k<x>\+1\);let @r@=\k<e>\.get\(@source@\);\k<e>\.set\(\k<source>,\k<t>\);try\{return \k<n>\(\)\}finally\{\k<e>\.set\(\k<source>,\k<r>\)\}\}`), text)
      .flatMap((m) => {
        const g = m.groups; const wrap = g.wrap ?? (exportsParam(text, m.index) ? `${exportsParam(text, m.index)}.${g.exp}` : null);
        return wrap ? [hit(m.index, objectOf([['wrap', wrap], ['counter', g.counter, true], ['source', g.source, true]]))] : [];
      }),
  },
  {
    // a chat's workspace as the app holds it (layouts.md D11, WL6; scout wl6-layouts.md, finding 2, Q1): its effective mode, what says its panels
    // are open, and the marks of its restore from the chat's checkpoint (the conversation restored, and ready), which a held layout applies after
    key: 'workspaceState',
    needle: 'panelId:`bottom`,getPanelOpenSignal:',
    // rolldown: one scope, the names as they are. rspack: the mode atom, the restore's marks and the panels' open signals are in different modules
    // (the chunk holds them all): the marks' module (the one that restores a chat's checkpoint) is the host; the others are read through its imports
    locate(text) {
      const one = (re) => { const ms = only(re, text); return ms.length === 1 ? ms[0] : null; };
      const mode = one(rx(String.raw`[,;]@mode@=(?:@make@|\(0,${ID}\.${ID}\))\(${REF},\(\{get:@e@\}\)=>\k<e>\(${REF}\)&&\(\k<e>\(${REF}\)\|\|(?:\k<e>\(${REF}\.tabs\$\)\.length===0|0===\k<e>\(${REF}\.tabs\$\)\.length)\)\?\`chat\`:`));
      const done = one(rx(String.raw`\(@e@\.set\((?<restored>${REF}),@t@\),\k<e>\.set\(${REF},!1\),\k<e>\.set\((?<ready>${REF}),!0\),@o@=(?:${ID}\(\k<e>|function\(\k<e>),\{browserConversationId:`));
      const bottom = one(rx(String.raw`panelId:\`bottom\`,getPanelOpenSignal:\(\)=>(?<open>${REF}),`));
      const right = one(rx(String.raw`panelId:\`right\`,getPanelOpenSignal:\(\)=>(?<open>${REF}),`));
      if (!mode || !done || !bottom || !right) return [];
      const mods = rspackModules(text);
      let names = { mode: mode.groups.mode, restored: done.groups.restored, ready: done.groups.ready, bottomOpen: bottom.groups.open, tabsOpen: right.groups.open };
      if (mods) {
        const host = moduleAt(mods, done.index);
        const at = { mode, restored: done, ready: done, bottomOpen: bottom, tabsOpen: right };
        names = Object.fromEntries(Object.entries(names).map(([k, ref]) => { const src = moduleAt(mods, at[k].index); return [k, host && src ? readFrom(text, mods, host, src, ref) : null]; }));
        if (!host || Object.values(names).some((v) => v == null)) return [];
      }
      const n = names;
      return [hit((mods ? done : mode).index + 1, objectOf([['mode', n.mode, true], ['restored', n.restored, true], ['ready', n.ready, true], ['bottomOpen', n.bottomOpen, true], ['tabsOpen', n.tabsOpen, true]]))];
    },
  },
  {
    // the window's regions as it shows them now (layouts.md D4, WL3): the sidebar's live width (its AppScope atom, whose initial value is
    // the one read of the stored `sidebar-width`; the app writes the key only when a drag ends), the app's clamp, and the bottom panel's
    // open setter. Each found by what it is: the width's functions read the variable assigned `sidebar-width`, and its atom is made from
    // them; the bottom panel's setter is the one its panel controller is built with (`panelId: 'bottom'`, `setPanelOpen`).
    key: 'windowRegions',
    needle: '`sidebar-width`',
    locate(text, { inits }) {
      const one = (re) => { const ms = only(re, text); return ms.length === 1 ? ms[0] : null; };
      const mods = rspackModules(text);
      if (mods) {
        // rspack: the width's functions are one module's (`let i="sidebar-width"; function a(){return s((0,r.TB)(i,340))} function s(..)`, exported),
        // the atom made from three of its exports is another's (the host), the bottom panel's setter a third's
        const width = one(rx(String.raw`function @read@\(\)\{return @clamp@\(\(0,${ID}\.${ID}\)\(@key@,340\)\)\}function \k<clamp>\(`));
        if (!width) return [];
        const g = width.groups; const wm = moduleAt(mods, width.index);
        if (!wm || !one(new RegExp(String.raw`[^\w$]${esc(g.key)}=\`sidebar-width\``.replaceAll('\\`', '[`"\']'), 'g'))) return [];
        const exp = (re) => { const body = text.slice(wm.open, wm.close); const ms = [...body.slice(body.lastIndexOf('.d(')).matchAll(re)]; return ms.length === 1 ? ms[0][1] : null; };
        const eRead = exp(new RegExp(String.raw`[{,](${ID}):${esc(g.read)}(?=[,}])`, 'g'));
        const eSnap = exp(new RegExp(String.raw`[{,](${ID}):function\(\)\{return ${esc(g.read)}\(\)\}`, 'g'));
        const eMount = exp(new RegExp(String.raw`[{,](${ID}):function\(${ID}\)\{\}`, 'g'));
        if (!eRead || !eSnap || !eMount) return [];
        const atom = one(new RegExp(String.raw`(?<atom>${ID})=\(0,${ID}\.${ID}\)\(${REF},(?<v>${ID})\.${esc(eRead)},\{getServerSnapshot:\k<v>\.${esc(eSnap)},onMount:\k<v>\.${esc(eMount)}\}\)`, 'g'));
        const bottom = one(rx(String.raw`@ctl@=@make@\(\{panelId:\`bottom\`,getPanelOpenSignal:\(\)=>(?<open>${REF}),setPanelOpen:@set@\}\)`));
        if (!atom || !bottom) return [];
        const host = moduleAt(mods, atom.index);
        if (!host || importsOf(text.slice(host.open, host.close)).get(atom.groups.v) !== wm.id) return [];
        const clamp = readFrom(text, mods, host, wm, g.clamp);
        const setBottom = readFrom(text, mods, host, moduleAt(mods, bottom.index), bottom.groups.set);
        if (!clamp || !setBottom) return [];
        return [hit(atom.index, objectOf([['sidebarWidth', atom.groups.atom, true], ['clampSidebar', clamp], ['setBottom', setBottom]]))];
      }
      const width = one(rx(String.raw`function @read@\(\)\{return @clamp@\(@get@\(@key@,340\)\)\}function @write@\(@e@\)\{@put@\(\k<key>,\k<clamp>\(\k<e>\)\)\}function @snap@\(\)\{return \k<read>\(\)\}function @mount@\(@x@\)\{\}function \k<clamp>\(`));
      if (!width) return [];
      const g = width.groups;
      if (!one(new RegExp(String.raw`[^\w$]${esc(g.key)}=\`sidebar-width\``, 'g'))) return [];
      const atom = one(new RegExp(String.raw`(?<atom>${ID})=${ID}\(${ID},${esc(g.read)},\{getServerSnapshot:${esc(g.snap)},onMount:${esc(g.mount)}\}\)`, 'g'));
      const bottom = one(rx(String.raw`@ctl@=@make@\(\{panelId:\`bottom\`,getPanelOpenSignal:\(\)=>@open@,setPanelOpen:@set@\}\)`));
      if (!atom || !bottom) return [];
      const name = atom.groups.atom;
      return [hit(atom.index, guarded([inits.ofVar(name) ?? inits.around(atom.index)?.name], objectOf([['sidebarWidth', name, true], ['clampSidebar', g.clamp], ['setBottom', bottom.groups.set]])))];
    },
  },
  {
    // the bottom panel's height bounds (layouts.md WL4b; scout wl4-workspace.md §2.4, B2): the app's own clamp (160 px to half the main
    // view's height), found with the read of the kept height it clamps (its key and its default of 280)
    key: 'bottomHeight',
    needle: '`app-shell:bottom-panel-height`',
    locate(text) {
      const read = only(rx(String.raw`function @clamp@\(@e@,@t@\)\{return Number\.isFinite\(\k<e>\)\?Math\.max\(160,Math\.min\(\k<e>,\k<t>\*\.5\)\):@d@\}function @read@\(@x@\)\{return \k<clamp>\(@get@\(@key@,280\),\k<x>\)\}`), text);
      // rspack: the read of the kept height is inlined into its users; the key is declared right before the clamp, whose default of 280 is in its body
      const ms = read.length ? read : only(rx(String.raw`@key@=\`app-shell:bottom-panel-height\`;function @clamp@\(@e@,@t@\)\{return Number\.isFinite\(\k<e>\)\?Math\.max\(160,Math\.min\(\k<e>,\.5\*\k<t>\)\):280\}`), text);
      if (ms.length !== 1) return [];
      const g = ms[0].groups;
      if (only(new RegExp(String.raw`[^\w$]${esc(g.key)}=\`app-shell:bottom-panel-height\``.replaceAll('\\`', '[`"\']'), 'g'), text).length !== 1) return [];
      return [hit(ms[0].index, objectOf([['clamp', g.clamp]]))];
    },
  },
  {
    // the app's own setters for space (layouts.md WL4d, D12; scout wl4-workspace.md §3.2, B4): the side panel closed for the window's size
    // and given back (its remembered state, the app's mark that the close was not the user's; the restore known by its body: it reads the
    // memory, reopens the tabs, else the panel, and clears the memory otherwise, all within its own body), and the sidebar's core open setter (never the
    // "by hand" one, which stops the app's own auto-collapse); with the atoms the allocator reads (the panel open, its memory, the auto flag)
    key: 'responsive',
    needle: '{closeReason:`window-resize`}',
    guarantees: Object.freeze(['closeSide', 'restoreSide', 'setSidebar', 'sideOpen', 'remembered', 'autoCollapse', 'sidebarOpen']),
    locate(text) {
      const one = (re) => { const ms = only(re, text); return ms.length === 1 ? ms[0] : null; };
      const side = one(rx(String.raw`function @oAn@\(@e@\)\{let @t@=\k<e>\.get\(@open@\);\k<e>\.set\(@mem@,\k<t>\?\k<e>\.get\(@tabs@\)\?\`tabs\`:\`detail\`:\`closed\`\),\k<t>&&@ZD@\(\k<e>,!1,\{closeReason:\`window-resize\`\}\)\}function @sAn@\(@e2@\)\{let @t2@=\k<e2>\.get\(\k<mem>\);(?:(?!function )[^]){0,40}?\k<t2>!=null(?:(?!function )[^]){0,40}?\k<t2>===\`tabs\`(?:(?!function )[^]){0,40}?@QD@\(\k<e2>,!0\)(?:(?!function )[^]){0,40}?\k<t2>===\`detail\`(?:(?!function )[^]){0,40}?\k<ZD>\(\k<e2>,!0\)(?:(?!function )[^]){0,40}?\k<e2>\.set\(\k<mem>,null\)`));
      const bar = one(rx(String.raw`function @core@\(@e@,@t@,@n@=\{\}\)\{@eAn@\(\k<e>,\k<t>,\k<n>\)\}function \k<eAn>\(@e2@,@t2@,@n2@\)\{[^]{0,200}?[,;{]\k<e2>\.set\(@sbOpen@,\k<t2>\)[^]{0,2000}?\}function @hand@\(@e3@,@t3@,@n3@=\{\}\)\{\k<e3>\.set\(@auto@,!1\),\k<core>\(\k<e3>,\k<t3>,\k<n3>\)\}`));
      if (side && bar) {
        const g = side.groups, b = bar.groups;
        // the sidebar's open atom: the one the core setter sets to what it is given (read at once, where the page's attribute follows later)
        return [hit(side.index, objectOf([['closeSide', g.oAn], ['restoreSide', g.sAn], ['setSidebar', b.core], ['sideOpen', g.open, true], ['remembered', g.mem, true], ['autoCollapse', b.auto, true], ['sidebarOpen', b.sbOpen, true]]))];
      }
      // rspack: the two side-panel functions and the by-hand setter are exports (`Kg:function(e){..}`, read as `t.Kg`), the sidebar's core setter wraps the
      // initialiser's body in a call of its own (`function Z(e,t,n={}){!function(e,t,n){..e.set(C,t)..}(e,t,n)}`); atoms are the module's or a member of an import
      if (!rspackModules(text)) return [];
      const close = one(rx(String.raw`[,{]@oAn@:function\(@e@\)\{let @t@=\k<e>\.get\((?<open>${REF})\);\k<e>\.set\((?<mem>${REF}),\k<t>\?\k<e>\.get\((?<tabs>${REF})\)\?\`tabs\`:\`detail\`:\`closed\`\),\k<t>&&(?<ZD>${REF})\(\k<e>,!1,\{closeReason:\`window-resize\`\}\)\}`));
      if (!close) return [];
      const c = close.groups;
      const restore = one(new RegExp(String.raw`[,{](?<sAn>${ID}):function\((?<e>${ID})\)\{let (?<t>${ID})=\k<e>\.get\(${esc(c.mem)}\);if\(null!=\k<t>\)\{if\([\`"']tabs[\`"']===\k<t>\)return void (?<QD>${REF})\(\k<e>,!0\);if\([\`"']detail[\`"']===\k<t>\|\|[^;]{0,40}?\)return void ${esc(c.ZD)}\(\k<e>,!0\);\k<e>\.set\(${esc(c.mem)},null\)\}\}`, 'g'));
      const core = one(rx(String.raw`function @core@\(@e@,@t@,@n@=\{\}\)\{!function\(@e2@,@t2@,@n2@\)\{[^]{0,200}?[,;{]\k<e2>\.set\((?<sbOpen>${REF}),\k<t2>\)[^]{0,2000}?\}\(\k<e>,\k<t>,\k<n>\)\}`));
      if (!restore || !core) return [];
      const hand = one(new RegExp(String.raw`[,{](?<h>${ID}):function\((?<e>${ID}),(?<t>${ID}),(?<n>${ID})=\{\}\)\{\k<e>\.set\((?<auto>${REF}),!1\),${esc(core.groups.core)}\(\k<e>,\k<t>,\k<n>\)\}`, 'g'));
      const ex = hand && exportsParam(text, close.index);
      if (!ex || exportsParam(text, restore.index) !== ex || exportsParam(text, hand.index) !== ex || core.groups.core === undefined) return [];
      const r = restore.groups;
      return [hit(close.index, objectOf([['closeSide', `${ex}.${c.oAn}`], ['restoreSide', `${ex}.${r.sAn}`], ['setSidebar', core.groups.core], ['sideOpen', c.open, true], ['remembered', c.mem, true], ['autoCollapse', hand.groups.auto, true], ['sidebarOpen', core.groups.sbOpen, true]]))];
    },
  },
  {
    // the side panel's bounds at a main width (layouts.md WL4d; scout wl4-workspace.md §4, B5): its floor and the chat's own minimum, read
    // where the app computes them (`bounds(main, mode)`: {maximum, minimum}), never copied (rspack writes the comparisons the other way round and the chat's minimum as a number)
    key: 'panelMaths',
    needle: '{maximum:',
    locate(text) {
      const ms = only(rx(String.raw`function @vrt@\(@e@,@t@\)\{return ?(?:\k<t>===\`full\`|\`full\`===\k<t>)\?Math\.max\(320,\k<e>\):Math\.max\(320,\k<e>-\((?:\k<t>===\`unified\`|\`unified\`===\k<t>)\?320:(?<chat>${ID}|\d+)\)\)\}function @bounds@\(@e2@,@t2@\)\{let @n@=\k<vrt>\(\k<e2>,\k<t2>\);return\{maximum:\k<n>,minimum:Math\.min\(320,\k<n>\)\}\}`), text);
      return ms.length === 1 ? [hit(ms[0].index, objectOf([['bounds', ms[0].groups.bounds]]))] : [];
    },
  },
  {
    // the app's resize divider (layouts.md WL4a; scout wl4-workspace.md §2.5, B6): the one component the sidebar and the side and bottom
    // panels draw their edges with (its pointer maths at the app's zoom, its keys, its indicator); found by its whole destructure
    key: 'ResizeDivider',
    needle: 'allowPointerOverflow:',
    locate: (text) => only(rx(String.raw`function @name@\(e\)\{let (?:${ID},)*${ID}=\(0,@c@\.c\)\(\d+\),\{action:@a@,allowPointerOverflow:@b@,ariaLabel:@d@,currentSize:@f@,edge:@g@,defaultSize:@h@,extendIntoToolbar:@i@,getCurrentSize:@j@,hitArea:@k@,indicator:@l@,indicatorVisibility:@m@,keyboardStep:@n@,maximumSize:@o@,minimumSize:@p@,onResizeEnd:@q@,onResizingChange:@r@,renderInTopLayer:@s@,(?:resizeFromCenter:@rc@,)?setSize:@u@\}=e[,;]`), text)
      .map((m) => hit(m.index, m.groups.name)),
  },
  {
    // the frame's context (layouts.md WL4a; scout wl4-frame.md §1): the shell's six motion values (its widths) and its flags, which the
    // workspace column and the title bar read; a frame host gives the column a narrowed one. Found by the read that refuses its absence.
    key: 'navigationShell',
    // the app calls it NavigationShell up to 22943 and WindowShell on rspack; the context is a name, or a module's member (`tf.F`)
    needle: 'Shell is missing',
    locate: (text, { inits }) => only(rx(String.raw`@ctx@=\(0,@R@\.useContext\)\((?<nav>${REF})\);if\((?:\k<ctx>==null|null==\k<ctx>)\)throw Error\(\`(?:Navigation|Window)Shell is missing\`\)`), text)
      .map((m) => hit(m.index, guarded([inits.ofVar(m.groups.nav) ?? inits.around(m.index)?.name], m.groups.nav))),
  },
  {
    // the sidebar's footer (layouts.md §4.1; scout wl2-groups-footer.md §2.3): its banners' and buttons' components, each read after its own
    // initialiser, found together by the footer's own body (its keyed stack and its account row) and three short reads of the same chunk
    key: 'sidebarFooter',
    needle: '`usage-alert`',
    // every member is a capture of the one locator: found with it, or the exposure is missing
    guarantees: Object.freeze(['usageAlert', 'checklist', 'financeChecklist', 'announcement', 'updateBanner', 'invite', 'stack', 'row', 'account', 'update']),
    locate(text, { inits }) {
      const one = (re) => { const ms = only(re, text); return ms.length === 1 ? ms[0] : null; };
      const body = one(rx(String.raw`\(0,@jx@\.jsx\)\(@usage@,\{\},\`usage-alert\`\)[^]{0,200}?\(0,\k<jx>\.jsx\)\(@finance@,\{fallback:@ne@\},\`getting-started\`\)[^]{0,300}?\(0,\k<jx>\.jsx\)\((?<wrap>${REF}),\{children:@W@\}\)[^]{0,200}?\(0,\k<jx>\.jsx\)\(@banner@,\{isVisible:@a@\},\`internal-update\`\)[^]{0,200}?\(0,\k<jx>\.jsxs\)\((?<stack>${REF}),\{children:\[[^\]]{0,40}\]\}\)[^]{0,300}?\(0,\k<jx>\.jsx\)\(@row@,\{leading:\(0,\k<jx>\.jsx\)\(@account@,\{\}\),trailing:@L@\?\(0,\k<jx>\.jsx\)\(@update@,\{variant:\`sidebarFooter\`\}\):null\}\)`));
      if (!body) return [];
      const g = body.groups;
      const checklist = one(new RegExp(String.raw`${ID}=${ID}\?\(0,${esc(g.jx)}\.jsx\)\((?<c>${ID}),\{\}\):\(0,${esc(g.jx)}\.jsx\)\(${esc(g.wrap)},\{children:null\}\)`, 'g'));
      const announcement = one(new RegExp(String.raw`\(0,${esc(g.jx)}\.jsx\)\((?<c>${ID}),\{announcement:${ID},onDismiss:${ID},onOpenPost:${ID}\},${ID}\)`, 'g'));
      const invite = one(new RegExp(String.raw`\(0,${ID}\.jsx\)\(${ID},\{\}\),\(0,${ID}\.jsx\)\((?<c>${ID}),\{layerParameter:\`desktop_button_enabled\`\}\)\]\}\),null,null,null,null,null\]`.replaceAll('\\`', '[`"\']'), 'g'));
      if (!checklist || !announcement || !invite) return [];
      const members = [['usageAlert', g.usage], ['checklist', checklist.groups.c], ['financeChecklist', g.finance], ['announcement', announcement.groups.c], ['updateBanner', g.banner],
        ['invite', invite.groups.c], ['stack', g.stack], ['row', g.row], ['account', g.account], ['update', g.update]];
      return [hit(body.index, objectOf(members.map(([k, v]) => [k, guarded([inits.ofVar(v)], v), true])))];
    },
  },
  {
    // the conversations sidebar's section state (layouts.md §4.1, D9; scout wl2-groups-footer.md §1.4): the effective atom holding the user's
    // saved group order (`sectionOrder`), found beside the derived order it feeds (pinned and orbit first, then the base keys)
    key: 'sidebarGroupState',
    needle: '[`pinned`,`orbit`,',
    locate: (text, { inits }) => only(rx(String.raw`@der@=(?<fac>${ID}|\(0,${ID}\.${ID}\))\((?<Q>${REF}),\(\{get:@e@\}\)=>\{let @t@=\k<e>\((?<acct>${REF})\);return (?:\k<t>==null|null==\k<t>)\?\{\.\.\.@VN@,sectionOrder:\k<e>\(@Ser@,@xer@\)\?\?\[\]\}:\k<e>\((?<fN>${REF})\)\[\k<t>\]\?\?\k<VN>\}\),@oer@=\k<fac>\(\k<Q>,\(\{get:\k<e>\}\)=>(?:${ID}\(\k<e>\(\k<der>\),|\{let @t2@=\k<e>\(\k<der>\);return\(0,${ID}\.${ID}\)\(\k<t2>,)\[\`pinned\`,\`orbit\`,`), text)
      .map((m) => hit(m.index, guarded([inits.ofVar(m.groups.der) ?? inits.around(m.index)?.name], objectOf([['sections', m.groups.der, true]])))),
  },
  {
    // the sortable container the conversations sidebar's groups are drawn in (dnd-kit's SortableContext; scout wl2-groups-footer.md §1.4):
    // its one call wrapped in a `contents` div; the component every sortable list of the app uses (a binding passes the others as they are)
    key: 'SidebarSortable',
    needle: '.sortableIds,strategy:',
    // tied to the groups it holds (layouts WL2-4a review): its children are the groups mapped from the section keys (teams, agents with
    // the dnd's `sectionReorderDnd`, chats), its items that same dnd's drag ids: a sortable `contents` wrapper alone is not enough
    // rspack: the comparisons are Yoda (`"teams"===e`) and the container is a member of an import (`ol.gB`)
    locate: (text, { inits }) => only(rx(String.raw`@zn@=@vt@\.map\(@e@=>(?:\k<e>===\`teams\`|\`teams\`===\k<e>)\?null:[^]{0,300}?(?:\k<e>===\`agents\`|\`agents\`===\k<e>)\?\(0,@jx@\.jsx\)\(@ag@,\{sectionReorderDnd:@gt@\},\k<e>\)[^]{0,600}?(?:\k<e>===\`chats\`|\`chats\`===\k<e>)\?[^]{0,2500}?\(0,\k<jx>\.jsx\)\(\`div\`,\{ref:@y@,className:\`contents\`,children:\(0,\k<jx>\.jsx\)\((?<kM>${REF}),\{items:\k<gt>\.sortableIds,strategy:(?<pm>${REF}),children:\k<zn>\}\)\}\)`), text)
      .map((m) => hit(m.index, guarded([inits.ofVar(m.groups.kM)], m.groups.kM))),
  },
  {
    // the app's atom factory for an atom whose value a function gives and a subscription refreshes (layouts.md §4.1; scout wl2-tab-kinds.md
    // §3.1): the framework makes its own epochs with it (a value only it writes, which the app's derived atoms read to recompute)
    key: 'atoms',
    needle: '`external`,{debugLabel:',
    // rolldown: a declared function; rspack: an export written `n.d(t,{},{S:function(e,t,n,o){..}})`, read as `t.S`, whose calls are members of imports
    locate: (text, { inits }) => only(rx(String.raw`(?:function @name@|[,{]@exp@:function)\(@e@,@t@,@n@,@r@\)\{let @i@=(?:@y@|\(0,${ID}\.${ID}\))\(\`cached\`,\k<e>,\(@p@,@a@\)=>(?:@z@|\(0,${ID}\.${ID}\))\(\k<e>,\k<p>,\k<a>,\k<e>=>(?:typeof \k<t>==\`function\`|\`function\`==typeof \k<t>)\?\k<t>\(\k<e>\):\k<t>,\k<n>,\k<r>\?\.isEqual\),\(\k<e>,\k<t>\)=>\{(?:@w@|\(0,${ID}\.${ID}\))\(\k<t>,\k<e>,\`external\`,\{debugLabel:\k<i>\.debugLabel\}\)\}\);return \k<i>\}`), text)
      .flatMap((m) => {
        const ex = m.groups.name ? null : exportsParam(text, m.index);
        if (!m.groups.name && !ex) return [];
        const close = matchClose(text, text.indexOf('{', m.index + m[0].indexOf('(')));
        return [hit(m.index, guarded([inits.after(close > 0 ? close : m.index)?.name], objectOf([['external', m.groups.name ?? `${ex}.${m.groups.exp}`]])))];
      }),
  },
  {
    // the new-tab launcher's order of the app's own actions in a git project (layouts.md §4.1; scout wl2-tab-kinds.md §0.6): a module table the
    // launcher sorts by; the framework writes the order its rules give into it
    key: 'launcherOrder',
    needle: '{review:0,"new-page":1,terminal:2,desktop:3,browser:4,"open-file":5}',
    locate(text, { inits }) {
      const ms = only(rx(String.raw`@name@=\{review:0,"new-page":1,terminal:2,desktop:3,browser:4,"open-file":5\}`), text);
      if (ms.length !== 1) return [];
      const name = ms[0].groups.name;
      if (only(new RegExp(String.raw`\.sort\(\(${ID},${ID}\)=>\(${esc(name)}\[${ID}\.id\]\?\?`, 'g'), text).length !== 1) return [];
      return [hit(ms[0].index, guarded([inits.ofVar(name) ?? inits.around(ms[0].index)?.name], objectOf([['table', name, true]])))];
    },
  },
  {
    key: 'panelControllers',
    needle: 'dropDestinations.includes(`bottom`)',
    locate: (text, { inits }) => only(rx(String.raw`(?:@open@=)?\(@e@,@t@,@n@\)=>\((?:\k<n>\.target===\`bottom\`|\`bottom\`===\k<n>\.target)&&\k<t>\.dropDestinations\.includes\(\`bottom\`\)\?@bottom@:@right@\)\.openTab\(\k<e>,\k<t>,\k<n>\)`), text)
      .map((m) => { const g = m.groups; return hit(m.index, guarded([(g.open ? inits.ofVar(g.open) : null) ?? inits.around(m.index)?.name, inits.ofVar(g.bottom), inits.ofVar(g.right)], objectOf([['openTab', g.open ?? m[0], true], ['right', g.right, true], ['bottom', g.bottom, true]]))); }),
  },
  {
    key: 'modal',
    needle: '.modals.some(',
    locate(text, { inits, file, corpus }) {
      const out = [];
      for (const m of only(rx(String.raw`function @isOpen@\(@s@,@c@\)\{return \k<s>\.get\(@atom@\)\.modals\.some\(@m@=>@same@\(\k<m>\.ModalComponent,\k<c>\)\)\}`), text)) {
        const { atom, same } = m.groups; const A = esc(atom); const S = esc(same);
        const find = (re) => { const r = matches(text, new RegExp(re, 'g')); return r.length === 1 ? r[0].groups : null; };
        const open = find(`function (?<open>${ID})\\((?<s>${ID}),(?<c>${ID}),(?<p>${ID}),(?<o>${ID})\\)\\{[^]{0,200}?\\k<s>\\.set\\(${A},[^]{0,220}?ModalComponent:\\k<c>,props:\\k<p>,blocksOtherModals:\\k<o>\\?\\.blocksOtherModals\\?\\?!0`);
        const close = find(`function (?<close>${ID})\\((?<s>${ID}),(?<c>${ID})\\)\\{[^]{0,120}?\\k<s>\\.set\\(${A},(?<m>${ID})=>\\{let (?<f>${ID})=\\k<m>\\.modals\\.filter\\((?<k>${ID})=>!${S}\\(\\k<k>\\.ModalComponent,\\k<c>\\)\\);return`);
        const closeAll = find(`function (?<closeAll>${ID})\\((?<s>${ID})\\)\\{[^]{0,80}?\\k<s>\\.set\\(${A},(?<m>${ID})=>\\(\\{\\.\\.\\.\\k<m>,modals:\\[\\]\\}\\)\\)`);
        if (!open || !close || !closeAll) continue;
        out.push(hit(m.index, guarded([inits.ofVar(atom), inits.after(m.index + m[0].length)?.name], objectOf([['open', open.open], ['close', close.close], ['closeAll', closeAll.closeAll], ['isOpen', m.groups.isOpen], ['atom', atom, true]]))));
      }
      if (out.length) return out;
      // rspack: the controllers are the module's exports (`key:function(…){…}` members of `i.d(t,{},{…})`), the atom is a module `let`
      for (const m of only(rx(String.raw`@isOpen@:function\(@s@,@c@\)\{return \k<s>\.get\(@atom@\)\.modals\.some\(@m@=>\{var @v@;return \k<v>=\k<m>\.ModalComponent,\k<v>===\k<c>\}\)\}`), text)) {
        const X = moduleNames(corpus, file, m.index)?.exports; if (!X) continue;
        const { atom } = m.groups; const A = esc(atom);
        const find = (re) => { const r = matches(text, new RegExp(re, 'g')); return r.length === 1 ? r[0].groups : null; };
        const open = find(`(?<open>${ID}):function\\((?<s>${ID}),(?<c>${ID}),(?<p>${ID}),(?<o>${ID})\\)\\{[^]{0,200}?\\k<s>\\.set\\(${A},[^]{0,220}?ModalComponent:\\k<c>,props:\\k<p>,blocksOtherModals:\\k<o>\\?\\.blocksOtherModals\\?\\?!0`);
        const close = find(`(?<close>${ID}):function\\((?<s>${ID}),(?<c>${ID})\\)\\{[^]{0,120}?\\k<s>\\.set\\(${A},(?<m>${ID})=>\\{let (?<f>${ID})=\\k<m>\\.modals\\.filter\\((?<k>${ID})=>\\{var (?<v>${ID});return \\k<v>=\\k<k>\\.ModalComponent,\\k<v>!==\\k<c>\\}\\);return`);
        const closeAll = find(`(?<closeAll>${ID}):function\\((?<s>${ID})\\)\\{let\\{modals:(?<t>${ID})\\}=\\k<s>\\.get\\(${A}\\);for\\(let (?<n>${ID}) of\\(\\k<s>\\.set\\(${A},(?<m>${ID})=>\\(\\{\\.\\.\\.\\k<m>,modals:\\[\\]\\}\\)\\),\\k<t>\\)\\)`);
        if (!open || !close || !closeAll) continue;
        out.push(hit(m.index, objectOf([['open', `${X}.${open.open}`], ['close', `${X}.${close.close}`], ['closeAll', `${X}.${closeAll.closeAll}`], ['isOpen', `${X}.${m.groups.isOpen}`], ['atom', atom, true]])));
      }
      return out;
    },
  },
  {
    key: 'commandStack',
    needle: '[`normal`,`fallback`]',
    locate(text, { inits, file, corpus }) {
      const old = only(rx(
        String.raw`function @reg@\(@e1@,@t1@,\{isActive:@n1@,priority:@r1@=\`normal\`\}\)\{let @i1@=\{handler:\k<t1>,isActive:\k<n1>,priority:\k<r1>\},@a1@=@map@\.get\(\k<e1>\)\?\?\[\];return \k<a1>\.push\(\k<i1>\),\k<map>\.set\(\k<e1>,\k<a1>\),\(\)=>\{let @t2@=\k<map>\.get\(\k<e1>\);if\(!\k<t2>\)return;let @n2@=\k<t2>\.lastIndexOf\(\k<i1>\);\k<n2>!==-1&&\(\k<t2>\.splice\(\k<n2>,1\),\k<t2>\.length===0&&\k<map>\.delete\(\k<e1>\)\)\}\}`
        + String.raw`function @run@\(@e3@,@t3@,@n3@\)\{return @runner@\(\k<e3>,void 0,\k<t3>,\k<n3>\)\}`
        + String.raw`function @key@\(@e4@,@t4@,@n4@\)\{return \k<runner>\(\k<e4>,\k<t4>,\`keyboard_shortcut\`,\k<n4>\)\}`
        + String.raw`function @has@\(@e5@\)\{return @defs@\.has\(\k<e5>\)\}(?:function ${ID}\(@e5b@\)\{return \k<map>\.get\(\k<e5b>\)\?\.some\(\(\{isActive:@x5@\}\)=>\k<x5>\(\)\)===!0\})?`
        + String.raw`function \k<runner>\(@e6@,@t6@,@n6@,@r6@\)\{let @i6@=\k<map>\.get\(\k<e6>\);for\(let @e7@ of\[\`normal\`,\`fallback\`\]\)for\(let @a6@=\(\k<i6>\?\.length\?\?0\)-1;\k<a6>>=0;\k<a6>--\)\{let @o6@=\k<i6>\?\.\[\k<a6>\];if\(\k<o6>\?\.priority===\k<e7>&&\k<o6>\.isActive\(\k<r6>\)&&\k<o6>\.handler\(\k<n6>,\k<t6>,\k<r6>\)!==!1\)return!0\}let @a7@=@def@\(\k<e6>\);return \k<a7>!=null&&\k<a7>\(\k<n6>\)!==!1\}`
        + String.raw`function \k<def>\(@e8@\)\{for\(let\[@t8@,@n8@\]of \k<defs>\)if\(\k<t8>===\k<e8>\)return \k<n8>\}`), text)
        .map((m) => { const g = m.groups; return hit(m.index, guarded([inits.ofVar(g.map), inits.ofVar(g.defs), inits.after(m.index + m[0].length)?.name],
          objectOf([['register', g.reg], ['run', g.run], ['runKeyboard', g.key], ['runner', g.runner], ['hasDefault', g.has], ['defaultHandler', g.def], ['stack', g.map, true], ['defaults', g.defs, true]]))); });
      if (old.length) return old;
      // rspack: the dispatcher is a function declaration, the rest are the module's exports; the default handler is an inlined function expression
      const out = [];
      for (const m of only(rx(String.raw`function @runner@\(@e6@,@t6@,@n6@,@r6@\)\{let @i6@=@map@\.get\(\k<e6>\);for\(let @e7@ of\[\`normal\`,\`fallback\`\]\)for\(let @a6@=\(\k<i6>\?\.length\?\?0\)-1;\k<a6>>=0;\k<a6>--\)\{let @o6@=\k<i6>\?\.\[\k<a6>\];if\(\k<o6>\?\.priority===\k<e7>&&\k<o6>\.isActive\(\k<r6>\)&&!1!==\k<o6>\.handler\(\k<n6>,\k<t6>,\k<r6>\)\)return!0\}let @a7@=(?<defFn>function\(@e8@\)\{for\(let\[@t8@,@n8@\]of @defs@\)if\(\k<t8>===\k<e8>\)return \k<n8>\})\(\k<e6>\);return null!=\k<a7>&&!1!==\k<a7>\(\k<n6>\)\}`), text)) {
        const g = m.groups; const X = moduleNames(corpus, file, m.index)?.exports; if (!X) continue;
        const M = esc(g.map); const R = esc(g.runner); const D = esc(g.defs);
        const find = (re) => { const r = matches(text, new RegExp(re, 'g')).filter((x) => corpus.moduleAt(file, x.index)?.id === corpus.moduleAt(file, m.index)?.id); return r.length === 1 ? r[0].groups : null; };
        const reg = find(`(?<k>${ID}):function\\((?<e1>${ID}),(?<t1>${ID}),\\{isActive:(?<n1>${ID}),priority:(?<r1>${ID})=(?:\`normal\`|"normal")\\}\\)\\{let (?<i1>${ID})=\\{handler:\\k<t1>,isActive:\\k<n1>,priority:\\k<r1>\\},(?<a1>${ID})=${M}\\.get\\(\\k<e1>\\)\\?\\?\\[\\];return \\k<a1>\\.push\\(\\k<i1>\\),${M}\\.set\\(\\k<e1>,\\k<a1>\\),\\(\\)=>\\{let (?<t2>${ID})=${M}\\.get\\(\\k<e1>\\);if\\(!\\k<t2>\\)return;let (?<n2>${ID})=\\k<t2>\\.lastIndexOf\\(\\k<i1>\\);-1!==\\k<n2>&&\\(\\k<t2>\\.splice\\(\\k<n2>,1\\),0===\\k<t2>\\.length&&${M}\\.delete\\(\\k<e1>\\)\\)\\}\\}`);
        const run = find(`(?<k>${ID}):function\\((?<e3>${ID}),(?<t3>${ID}),(?<n3>${ID})\\)\\{return ${R}\\(\\k<e3>,void 0,\\k<t3>,\\k<n3>\\)\\}`);
        const key = find(`(?<k>${ID}):function\\((?<e4>${ID}),(?<t4>${ID}),(?<n4>${ID})\\)\\{return ${R}\\(\\k<e4>,\\k<t4>,(?:\`keyboard_shortcut\`|"keyboard_shortcut"),\\k<n4>\\)\\}`);
        const has = find(`(?<k>${ID}):function\\((?<e5>${ID})\\)\\{return ${D}\\.has\\(\\k<e5>\\)\\}`);
        if (!reg || !run || !key || !has) continue;
        out.push(hit(m.index, objectOf([['register', `${X}.${reg.k}`], ['run', `${X}.${run.k}`], ['runKeyboard', `${X}.${key.k}`], ['runner', g.runner], ['hasDefault', `${X}.${has.k}`], ['defaultHandler', g.defFn], ['stack', g.map, true], ['defaults', g.defs, true]])));
      }
      return out;
    },
  },
  {
    key: 'commandRegistered',
    needle: 'keyboardHandler:',
    locate(text, { inits, file, corpus }) {
      const out = [];
      for (const m of only(rx(String.raw`\.set\(@atom@,@u@=>@add@\(\k<u>,@e@,@item@\)\),\(\)=>\{@un@\(\),@sc@\.set\(\k<atom>,\k<u>=>@rem@\(\k<u>,\k<e>,\k<item>\)\)\}`), text)) {
        const g = m.groups;
        const addDef = new RegExp(`function ${esc(g.add)}\\((${ID}),(${ID}),(${ID})\\)\\{return\\{\\.\\.\\.\\1,\\[\\2\\]:\\[\\.\\.\\.\\1\\[\\2\\]\\?\\?\\[\\],\\3\\]\\}\\}`).exec(text);
        const remDef = new RegExp(`function ${esc(g.rem)}\\((${ID}),(${ID}),(${ID})\\)\\{let (${ID})=\\1\\[\\2\\];if\\(\\4==null\\)return \\1;let (${ID})=\\4\\.lastIndexOf\\(\\3\\);if\\(\\5===-1\\)return \\1;`).exec(text);
        const fn = enclosingFunction(text, m.index);
        if (!addDef || !remDef || !fn) continue;
        out.push(hit(m.index, guarded([inits.ofVar(g.atom), inits.after(fn.end)?.name], objectOf([['useHandler', fn.name], ['addRegistered', g.add], ['removeRegistered', g.rem], ['atom', g.atom, true]]))));
      }
      if (out.length) return out;
      // rspack: the hook is an exported function expression, the atom is another module's (`l.tu`), the add and remove helpers are inlined in the effect
      const X = (i) => moduleNames(corpus, file, i)?.exports;
      for (const m of only(rx(String.raw`\.set\((?<atom>${ID}\.${ID}),@u@=>\{var @r@,@i@,@a@;return \k<r>=\k<u>,\k<i>=@e@,\k<a>=@item@,\{\.\.\.\k<r>,\[\k<i>\]:\[\.\.\.\k<r>\[\k<i>\]\?\?\[\],\k<a>\]\}\}\),\(\)=>\{@un@\(\),@sc@\.set\(\k<atom>,\k<u>=>\(function\(@p1@,@p2@,@p3@\)\{let @q@=\k<p1>\[\k<p2>\];if\(null==\k<q>\)return \k<p1>;let @qi@=\k<q>\.lastIndexOf\(\k<p3>\);if\(-1===\k<qi>\)return \k<p1>;`), text)) {
        const g = m.groups; const exp = X(m.index); const fn = exportedFn(text, m.index);
        if (!exp || !fn) continue;
        const open = text.indexOf('(function(', m.index) + 1;
        const close = matchClose(text, text.indexOf('{', open));
        if (close < 0) continue;
        const remove = text.slice(open, close + 1);
        out.push(hit(m.index, objectOf([['useHandler', `${exp}.${fn.name}`], ['addRegistered', '(s,k,i)=>({...s,[k]:[...s[k]??[],i]})'], ['removeRegistered', remove], ['atom', g.atom, true]])));
      }
      return out;
    },
  },
  {
    key: 'slashRegistry',
    needle: 'searchAliases',
    locate: (text, { inits }) => [...only(rx(SLASH_OLD), text), ...only(rx(SLASH_NEW), text)]
      .map((m) => { const g = m.groups; return hit(m.index, guarded([inits.around(m.index)?.name], objectOf([['appAtom', g.app, true], ['composerAtom', g.comp, true], ['openCountAtom', g.cnt, true], ['mergedAtom', g.merged, true], ['sortItems', g.sort]]))); }),
  },
  {
    key: 'slashHooks',
    needle: 'searchAliases',
    locate(text, { inits, file, corpus }) {
      const reg = [...only(rx(SLASH_OLD), text), ...only(rx(SLASH_NEW), text)];
      if (reg.length !== 1) return [];
      const { app, comp } = reg[0].groups;
      const setterIn = (atom) => matches(text, new RegExp(`=(${ID})=>\\{(${ID})\\.set\\(${esc(atom)},\\1\\)\\}`, 'g')).map((m) => fnAround(text, m.index)).filter(Boolean);
      const compFns = setterIn(comp); const appFns = setterIn(app);
      // the composer registers one item (1 parameter) or a list (3 parameters); the app registers one item
      const params = (f) => new RegExp(`^function${f.exported ? '' : ` ${esc(f.name)}`}\\(([^)]*)\\)`).exec(text.slice(f.start, f.start + 120))?.[1].split(',').filter(Boolean).length;
      const one = compFns.filter((f) => params(f) === 1); const list = compFns.filter((f) => params(f) === 3); const appOne = appFns.filter((f) => params(f) === 1);
      if (compFns.length !== 2 || one.length !== 1 || list.length !== 1 || appFns.length !== 1 || appOne.length !== 1) return [];
      const core = new RegExp(`,(${ID})\\(${ID},${ID},${ID},null\\)\\}$`).exec(text.slice(appOne[0].start, appOne[0].end + 1))?.[1];
      if (!core || !new RegExp(`function ${esc(core)}\\(${ID},${ID},${ID},${ID}\\)\\{`).test(text)) return [];
      // rspack: the hooks are exported function expressions (`key:function(…){…}`), named through the module's exports object
      const X = appOne[0].exported ? moduleNames(corpus, file, reg[0].index)?.exports : null;
      if (appOne[0].exported && !X) return [];
      const nm = (f) => (f.exported ? `${X}.${f.name}` : f.name);
      return [hit(reg[0].index, guarded([inits.after(appOne[0].end)?.name], objectOf([['useComposerItem', nm(one[0])], ['useComposerItems', nm(list[0])], ['useAppItem', nm(appOne[0])], ['registerCore', core]])))];
    },
  },
  {
    key: 'routes',
    needle: 'element:void 0,children:',
    locate: (text, { inits }) => only(rx(String.raw`(?:,|let )@wrap@=\(0,@jsx@\.jsx\)\(${ID}(?:\.${ID})?,\{element:void 0,children:@inner@\}\),@table@=(?:\(0,${ID}\.${ID}\)|${ID})\(\k<wrap>\)(?=\}\)\)\)\(\)\}|;)`), text)
      .map((m) => hit(m.index, guarded([inits.around(m.index)?.name], m.groups.table))),
  },
  {
    key: 'panelSlots',
    needle: 'HeaderContextMenuItem:',
    locate(text, { inits }) {
      const re = rx(String.raw`function @f@\(@e@\)\{let\{children:@c@\}=\k<e>;return @pub@\(@hi@\(@sc@\),@atom@,\k<c>\),null\}`);
      const all = matches(text, re);
      if (all.length >= 4) {
        const key = (m) => `${m.groups.pub}|${m.groups.hi}|${m.groups.sc}`;
        if (new Set(all.map(key)).size !== 1 || all.at(-1).index - all[0].index > 6000) return [];
        const pub = all[0].groups.pub;
        const fnPub = matches(text, new RegExp(`function ${esc(pub)}\\(${ID},${ID},${ID}\\)\\{`, 'g'));
        if (fnPub.length !== 1) return [];
        const body = text.slice(fnPub[0].index, matchClose(text, fnPub[0].index + fnPub[0][0].length - 1) + 1);
        if (!body.includes('useLayoutEffect') || !body.includes('.set(')) return [];
        const atoms = all.map((m) => m.groups.atom);
        const pairs = `[${all.map((m) => `[${m.groups.f},${m.groups.atom}]`).join(',')}]`;
        return [hit(all[0].index, guarded([...atoms.map((a) => inits.ofVar(a)), inits.after(fnPub[0].index)?.name], objectOf([['publish', pub], ['pairs', pairs, true]])))];
      }
      // rspack: the slot components are the app-shell namespace's members `Key:(0,a.memo)(function(e){let{children:t}=e,n=(0,o.gh)(c.GD);return(0,J.I)(n,x.i7,t),null})`
      // (the namespace is the module's `let nK={Root:…}`); the pair's component is the memo element's `.type`; the publisher is another module's export (`J.I`)
      const slots = matches(text, rx(String.raw`@key@:\(0,@memo@\.memo\)\(function\(@e@\)\{let\{children:@c@\}=\k<e>,@n@=\(0,${ID}\.${ID}\)\((?<sc>${ID}\.${ID})\);return\(0,(?<pub>${ID}\.${ID})\)\(\k<n>,(?<atom>${ID}\.${ID}),\k<c>\),null\}\)`));
      if (slots.length < 4) return [];
      if (new Set(slots.map((m) => `${m.groups.pub}|${m.groups.sc}`)).size !== 1 || slots.at(-1).index - slots[0].index > 6000) return [];
      const ns = matches(text.slice(0, slots[0].index), rx(String.raw`(?:let |var |,)@ns@=\{Root:`)).at(-1)?.groups.ns;
      if (!ns) return [];
      const pairs = `[${slots.map((m) => `[${ns}.${m.groups.key}.type,${m.groups.atom}]`).join(',')}]`;
      return [hit(slots[0].index, objectOf([['publish', slots[0].groups.pub], ['pairs', pairs, true]]))];
    },
  },
  {
    key: 'shellSignals',
    needle: 'desktopPlacement:',
    locate(text, { inits, file, corpus }) {
      const out = [];
      const head = rx(String.raw`function @hdr@\(@p@\)\{[^]{0,80}?\{children:@c@,className:@cn@,contentFade:@cf@,divider:@dv@,desktopPlacement:@dp@,inline:@inl@,separator:@sp@\}=\k<p>,`
        + String.raw`@vcf@=\k<cf>===void 0\|\|\k<cf>,@vdv@=\k<dv>===void 0\|\|\k<dv>,@vdp@=\k<dp>===void 0\?\`page\`:\k<dp>,@vsp@=\k<sp>!==void 0&&\k<sp>,@vch@=\k<inl>\?null:\k<c>,`);
      for (const m of matches(text, head)) {
        const g = m.groups;
        const fn = enclosingFunction(text, m.index + m[0].length);
        if (!fn || fn.name !== g.hdr) continue;
        const body = text.slice(fn.start, fn.end + 1);
        const signalOf = (value) => {
          const holder = new RegExp(`(?:let |,)(${ID})=${esc(g.inl)}\\?null:${esc(value)}[,;]`).exec(body)?.[1];
          if (!holder) return null;
          const sig = matches(body, new RegExp(`\\(0,${ID}\\.jsxs?\\)\\((${ID}),\\{signal:(${ID}),value:${esc(holder)}\\}\\)`, 'g'));
          return sig.length === 1 ? { Signal: sig[0][1], signal: sig[0][2] } : null;
        };
        const sigs = { children: signalOf(g.c), desktopPlacement: signalOf(g.vdp), contentFade: signalOf(g.vcf), divider: signalOf(g.vdv), separator: signalOf(g.vsp) };
        if (Object.values(sigs).some((s) => !s) || new Set(Object.values(sigs).map((s) => s.Signal)).size !== 1) continue;
        const Signal = sigs.children.Signal;
        const banner = matches(text, new RegExp(`function (${ID})\\((${ID})\\)\\{[^]{0,80}?\\{children:(${ID})\\}=\\2,[^]{0,80}?\\(0,${ID}\\.jsx\\)\\(${esc(Signal)},\\{signal:(${ID}),value:\\3\\}\\)`, 'g'))
          .filter((b) => b.index > fn.end && b.index - fn.end < 400);
        if (banner.length !== 1) continue;
        const bannerSignal = banner[0][4];
        const vars = [...Object.values(sigs).map((s) => s.signal), bannerSignal, Signal];
        out.push(hit(m.index, guarded([...vars.map((v) => inits.ofVar(v)), inits.after(fn.end)?.name],
          objectOf([['Signal', Signal, true],
            ['header', `{component:${g.hdr},children:${sigs.children.signal},desktopPlacement:${sigs.desktopPlacement.signal},contentFade:${sigs.contentFade.signal},divider:${sigs.divider.signal},separator:${sigs.separator.signal}}`, true],
            ['pageBanner', `{component:${banner[0][1]},signal:${bannerSignal}}`, true]]))));
      }
      if (out.length) return out;
      // rspack (module MCtJ, a few lines long): the header and banner are the module's two exported function expressions (`F:function(e){…}`, `f:function(e){…}`);
      // the signal component and the signals are other modules' exports, read as `o.F`, `r.Wg` through the module's own `var o=n("…")` bindings
      const SIG = `${ID}\\.${ID}`;
      for (const m of matches(text, rx(String.raw`(?<hdr>${ID}):function\(@p@\)\{[^]{0,120}?\{children:@c@,className:@cn@,contentFade:@cf@,divider:@dv@,desktopPlacement:@dp@,inline:@inl@,separator:@sp@\}=\k<p>,@vsp@=void 0!==\k<sp>&&\k<sp>,@vch@=\k<inl>\?null:\k<c>;`))) {
        const g = m.groups; const exp = moduleNames(corpus, file, m.index)?.exports; const fn = exportedFn(text, m.index + m[0].length);
        if (!exp || !fn || fn.name !== g.hdr) continue;
        const body = text.slice(fn.start, fn.end + 1);
        const signalOf = (value) => {
          const holder = new RegExp(`(?:let |,)(${ID})=${esc(g.inl)}\\?null:${esc(value)}[,;]`).exec(body)?.[1];
          if (!holder) return null;
          const sig = matches(body, new RegExp(`\\(0,${ID}\\.jsxs?\\)\\((${SIG}),\\{signal:(${SIG}),value:${esc(holder)}\\}\\)`, 'g'));
          return sig.length === 1 ? { Signal: sig[0][1], signal: sig[0][2] } : null;
        };
        const sigs = { children: signalOf(g.c), desktopPlacement: signalOf(`void 0===${g.dp}?"page":${g.dp}`), contentFade: signalOf(`void 0===${g.cf}||${g.cf}`), divider: signalOf(`void 0===${g.dv}||${g.dv}`), separator: signalOf(g.vsp) };
        if (Object.values(sigs).some((s) => !s) || new Set(Object.values(sigs).map((s) => s.Signal)).size !== 1) continue;
        const Signal = sigs.children.Signal;
        const banner = matches(text.slice(fn.end + 1, fn.end + 400), new RegExp(`^,(${ID}):function\\((${ID})\\)\\{[^]{0,80}?\\{children:(${ID})\\}=\\2[,;][^]{0,80}?\\(0,${ID}\\.jsx\\)\\(${esc(Signal)},\\{signal:(${SIG}),value:\\3\\}\\)`, 'g'));
        if (banner.length !== 1) continue;
        out.push(hit(m.index, objectOf([['Signal', Signal, true],
          ['header', `{component:${exp}.${g.hdr},children:${sigs.children.signal},desktopPlacement:${sigs.desktopPlacement.signal},contentFade:${sigs.contentFade.signal},divider:${sigs.divider.signal},separator:${sigs.separator.signal}}`, true],
          ['pageBanner', `{component:${exp}.${banner[0][1]},signal:${banner[0][4]}}`, true]])));
      }
      return out;
    },
  },
  scopeExposure('AppScope'),
  scopeExposure('ComposerScope'),
  scopeExposure('RouteScope'),
  scopeExposure('ThreadScope'),
  {
    key: 'toast',
    needle: '.closeAll()}}',
    locate(text, { inits, file, corpus }) {
      const old = only(rx(String.raw`function @get@\(\)\{return @cur@\}function @bind@\(@p@\)\{return \k<cur>=\k<p>,\(\)=>\{\k<cur>===\k<p>&&\(\k<cur>=@stub@\)\}\}function @link@\(@s@,@t@\)\{return \k<s>\.set\(@atom@,\k<t>\),\(\)=>\{\k<s>\.get\(\k<atom>\)===\k<t>&&\k<s>\.set\(\k<atom>,\k<stub>\),\k<t>\.closeAll\(\)\}\}`), text)
        .map((m) => { const g = m.groups; return hit(m.index, guarded([inits.ofVar(g.cur), inits.ofVar(g.atom), inits.after(m.index + m[0].length)?.name], objectOf([['get', g.get], ['atom', g.atom, true]]))); });
      if (old.length) return old;
      // rspack: the module's `let d=1,u={close:()=>{}},p={info:()=>u,…,closeAll:()=>{}},h=p,E=(0,r.vP)(s.u,p)` (stub p, current API h, atom E), then the exported
      // `link` (`_0:function(e,t){return e.set(E,t),()=>{…}}`) and `bind` (`uP:function(e){return h=e,()=>{h===e&&(h=p)}}`); `get` is the current API
      return only(rx(String.raw`let @d@=1,@u@=\{close:\(\)=>\{\}\},@stub@=\{info:\(\)=>\k<u>,success:\(\)=>\k<u>,warning:\(\)=>\k<u>,danger:\(\)=>\k<u>,custom:\(\)=>\k<u>,closeAll:\(\)=>\{\}\},@cur@=\k<stub>,@atom@=\(0,@r@\.[\w$]+\)\(${ID}\.${ID},\k<stub>\)[^]*?[,{]${ID}:function\(@s2@,@t@\)\{return \k<s2>\.set\(\k<atom>,\k<t>\),\(\)=>\{\k<s2>\.get\(\k<atom>\)===\k<t>&&\k<s2>\.set\(\k<atom>,\k<stub>\),\k<t>\.closeAll\(\)\}\}`), text)
        .filter((m) => new RegExp(`[,{]${ID}:function\\((${ID})\\)\\{return ${esc(m.groups.cur)}=\\1,\\(\\)=>\\{${esc(m.groups.cur)}===\\1&&\\(${esc(m.groups.cur)}=${esc(m.groups.stub)}\\)\\}\\}`).test(text.slice(m.index, corpus.moduleAt(file, m.index)?.close ?? m.index)))
        .map((m) => hit(m.index, objectOf([['get', `()=>${m.groups.cur}`], ['atom', m.groups.atom, true]])));
    },
  },
  {
    key: 'bus',
    needle: 'isListeningToWindow',
    locate(text, { inits }) {
      const out = [];
      for (const m of only(rx(String.raw`(?:@name@=)?class @c@\{static instance=null;static getInstance\(\)\{return (?:this\.instance\?\?=new \k<c>|null==this\.instance&&\(this\.instance=new \k<c>\)),this\.instance\}`), text)) {
        const open = m.index + m[0].indexOf('{');
        const end = matchClose(text, open);
        const body = end < 0 ? '' : text.slice(open, end + 1);
        const name = m.groups.name ?? m.groups.c;
        if (['bufferedMessages', 'dispatchHostMessage', 'isListeningToWindow'].every((k) => body.includes(k))) out.push(hit(m.index, guarded([(m.groups.name ? inits.ofVar(m.groups.name) : null) ?? inits.around(m.index)?.name], name)));
      }
      return out;
    },
  },
  {
    key: 'react',
    needle: '.useSyncExternalStore=function',
    locate(text, { file, corpus }) {
      if (occurrences(text, 'e.useSyncExternalStore=function') === 1) {
        const at = text.indexOf('e.useSyncExternalStore=function');
        const re = rx(String.raw`(?:^|[,;\s])@wrap@=@cjs@\(\(\(?e\)?=>\{`);
        let last = null;
        for (const m of matches(text.slice(0, at), re)) last = m;
        if (!last || !/e\.version=`\d+\.\d+\.\d+[^`]*`/.test(text.slice(at, at + 90000))) return [];
        const alias = new RegExp(`(?:^|[,;\\s])(${ID})=${esc(last.groups.cjs)}\\(\\(\\(e,t\\)=>\\{t\\.exports=${esc(last.groups.wrap)}\\(\\)\\}\\)\\)`).exec(text);
        return alias ? [hit(at, `${last.groups.wrap}()`)] : [];
      }
      // rspack: React is a plain CommonJS module (`Vlts(e,t){…t.useSyncExternalStore=function…,t.version="19.2.7"}`); its exports object is the factory's 2nd parameter
      const ms = matches(text, new RegExp(`(?<![\\w$.])(${ID})\\.useSyncExternalStore=function\\(`, 'g'));
      if (ms.length !== 1) return [];
      const names = moduleNames(corpus, file, ms[0].index);
      if (!names || ms[0][1] !== names.exports || !new RegExp(`(?<![\\w$.])${esc(names.exports)}\\.version="\\d+\\.\\d+\\.\\d+[^"]*"`).test(text.slice(ms[0].index, names.mod.close))) return [];
      return [hit(ms[0].index, names.exports)];
    },
  },
  {
      key: 'useScope',
      needle: 'getOwnValue',
      locate: (text, { inits }) => only(rx(String.raw`function @f@\(@e@\)\{let @t@=\(0,${ID}\.useContext\)\(${SCOPE_CALL}\(\k<e>\)\),@n@=${SCOPE_CALL}\(\k<t>,\k<e>\),@r@=${SCOPE_CALL}\(\k<n>\),@i@=\(0,${ID}\.useRef\)\(null\);if\((?:\k<i>\.current==null|null==\k<i>\.current)\|\|\k<i>\.current\.node!==\k<n>\)\{let @a@=\{chain:\k<t>,getOwnValue`), text)
        .map((m) => { const fn = enclosingFunction(text, m.index + m[0].length - 1); return hit(m.index, guarded([inits.after(fn ? fn.end : m.index)?.name], m.groups.f)); }),
    },
  {
    key: 'composerBanners',
    needle: 'misalignment-policy',
    locate(text, { file, corpus }) {
      const out = [];
      // rspack: the module is the data (`let i=[{id:"misalignment-policy",areas:[…`) with the selection and the candidate constructor as its exports; the list
      // component is another module's (it requires this one), read through this module's own require function
      for (const m of only(rx(String.raw`let @list@=\[\{id:\`misalignment-policy\`,areas:\[`), text)) {
        const { list } = m.groups; const names = moduleNames(corpus, file, m.index);
        if (!names) continue;
        const close = matchClose(text, text.indexOf('[', m.index + 8));
        if (close < 0) continue;
        const sel = matches(text, new RegExp(`(${ID}):function\\((${ID}),(${ID})\\)\\{for\\(let\\{id:(${ID}),areas:(${ID})\\}of ${esc(list)}\\)\\{`, 'g')).filter((x) => x.index > close && x.index < names.mod.close);
        const mk = matches(text, new RegExp(`(${ID}):function\\((${ID}),(${ID})\\)\\{return\\{id:\\2,isEligible:null!=\\3&&"boolean"!=typeof \\3,isLoading:!1,content:\\3\\}\\}`, 'g')).filter((x) => x.index > close && x.index < names.mod.close);
        // the list component: the module (of this chunk) that requires this one and destructures `{area,candidates,homeCandidates}=e`; its export is the function holding that
        const comps = [];
        for (const c of matches(text, new RegExp(`\\{area:${ID},candidates:${ID},homeCandidates:${ID}\\}=`, 'g'))) {
          const cm = corpus.moduleAt(file, c.index); const fn = exportedFn(text, c.index);
          if (cm && cm.id !== names.id && fn && new RegExp(`${ID}=${esc(names.require)}\\("${esc(names.id)}"\\)`).test(text.slice(cm.open, cm.open + 400))) comps.push({ id: cm.id, key: fn.name });
        }
        if (sel.length !== 1 || mk.length !== 1 || comps.length !== 1) continue;
        out.push(hit(m.index, objectOf([['select', `${names.exports}.${sel[0][1]}`], ['candidate', `${names.exports}.${mk[0][1]}`], ['List', `${names.require}("${comps[0].id}").${comps[0].key}`], ['order', list, true]])));
      }
      if (out.length) return out;
      for (const m of only(rx(String.raw`var @list@;function @init@\(\)\{return\(\k<init>=@w@\(\(\(\)=>\{\k<list>=\[\{id:\`[\w-]+\`,areas:\[`), text)) {
        const { list } = m.groups;
        const close = matchClose(text, text.indexOf('[', m.index + m[0].length - 12));
        if (close < 0 || !text.slice(m.index, close).includes('`misalignment-policy`')) continue;
        const sel = matches(text, new RegExp(`function (${ID})\\((${ID}),(${ID})\\)\\{for\\(let\\{id:(${ID}),areas:(${ID})\\}of ${esc(list)}\\)\\{`, 'g'));
        const mk = matches(text, new RegExp(`function (${ID})\\((${ID}),(${ID})\\)\\{return\\{id:\\2,isEligible:\\3!=null&&typeof \\3!=\`boolean\`,isLoading:!1,content:\\3\\}\\}`, 'g'));
        const comp = matches(text, new RegExp(`\\{area:${ID},candidates:${ID},homeCandidates:${ID}\\}=`, 'g')).map((c) => enclosingFunction(text, c.index)).filter(Boolean);
        if (sel.length !== 1 || mk.length !== 1 || comp.length !== 1) continue;
        out.push(hit(m.index, guarded([m.groups.init], objectOf([['select', sel[0][1]], ['candidate', mk[0][1]], ['List', comp[0].name], ['order', list, true]]))));
      }
      return out;
    },
  },
  {
    key: 'reactDom',
    needle: '.createRoot=function',
    locate(text, { file, corpus }) {
      const dom = cjsWrapper(text, 'e.createPortal=function');
      const client = cjsWrapper(text, 'e.createRoot=function');
      if (dom || client) return dom && client && dom !== client ? [hit(text.indexOf('e.createRoot=function'), `({...${dom}(),...${client}()})`)] : [];
      // rspack: react-dom/client is one module (`i5yi(e,n,t){…n.createRoot=function…}`), and it requires react-dom itself (`o=t("v7qY")`, an alias
      // `e.exports=t("Ji1y")` of the module that assigns `createPortal`): both are in this module, as its exports object and one of its requires
      const ms = matches(text, new RegExp(`(?<![\\w$.])(${ID})\\.createRoot=function\\(`, 'g'));
      if (ms.length !== 1) return [];
      const names = moduleNames(corpus, file, ms[0].index);
      if (!names || ms[0][1] !== names.exports) return [];
      const mods = corpus.modules(file); const byId = (id) => mods.find((m) => m.id === id);
      const holdsPortal = (id, hops = 2) => {
        const m = byId(id); if (!m) return false;
        const src = text.slice(m.open, m.close + 1);
        if (new RegExp(`(?<![\\w$.])${ID}\\.createPortal=function\\(`).test(src)) return true;
        const p = m.params.split(',');
        const alias = new RegExp(`${esc(p[0])}\\.exports=${esc(p[2])}\\("([\\w$]+)"\\)`).exec(src);
        return hops > 0 && alias != null && holdsPortal(alias[1], hops - 1);
      };
      const head = text.slice(names.mod.open, names.mod.open + 400);
      const doms = matches(head, new RegExp(`(?<![\\w$.])(${ID})=${esc(names.require)}\\("([\\w$]+)"\\)`, 'g')).filter((r) => holdsPortal(r[2]));
      if (doms.length !== 1) return [];
      return [hit(ms[0].index, `({...${doms[0][1]},...${names.exports}})`)];
    },
  },
  varExposure('Button', '=`button`,color:', rx(String.raw`@name@=@e@=>\{let\{type:@a@=\`button\`,color:@b@=\`primary\`,variant:@c@=\`solid\`,pill:`)),
  // The Codex app's own button (its toolbars, cards and approval cards draw with it: color outline/ghost/primary, size composer/toolbar);
  // `Button` above is the shared design system's. Its implementation, found by its own first props (E8.9).
  // a chat of the app's in a mod's place (layouts.md D8, WL7; scout wl7-hosted.md): the app's provider of a chat's Thread and Route scopes from a route record; its lazy host of a second
  // chat (it provides its composer's scope, resumes the chat, draws its transcript, composer and requests), which carries its own `prefetch`; and for a chat without its composer, the
  // scope's Provider, the builder of a composer scope's value and the thread view (in the lazy chunk: defined once it has evaluated)
  fnExposure('routeScopes', '{archivedConversationPreview:', rx(String.raw`function @name@\(@e@\)\{let (?:[\w$]+,)*?@t@=\(0,@c@\.c\)\(\d+\),\{archivedConversationPreview:@a@,children:@b@,closeWorkspaceHome:@d@,contentChat:@f@,route:@r@(?:,viewKey:[\w$]+)?\}=\k<e>,@s@=(?:\k<a>!==void 0&&\k<a>|void 0!==\k<a>&&\k<a>),`)),
  varExposure('conversationTab', 'LocalConversationBackgroundAgentTab', rx(String.raw`@name@=(?:@L@|\(0,@L2@\._\))\(async\(\)=>\{let\{LocalConversationBackgroundAgentTab:@e@\}=await (?:@G@\(async\(\)=>\{let\{LocalConversationBackgroundAgentTab:\k<e>\}=await import\(\`\./local-conversation-thread-[\w-]+\.js\`\);return\{LocalConversationBackgroundAgentTab:\k<e>\}\},__vite__mapDeps\(\[[\d,]+\]\),import\.meta\.url\)|Promise\.all\(\[[^\]]*\]\)\.then\(@I@\.bind\(\k<I>,\`[\w$]+\`\)\));return \k<e>\},\{propagateLoadError:!0\}\)`)),
  fnExposure('ScopeProvider', '{children:e,scope:t,value:n}', rx(String.raw`function @name@\(\{children:e,scope:t,value:n\}\)\{let [\w$]+=\(0,@R@\.useContext\)\(@A@\),[\w$]+=\(0,\k<R>\.useContext\)\(@B@\),[\w$]+=(?:t\.parent==null|null==t\.parent)\?void 0:`)),
  fnExposure('composerScopeValue', 'Pending local composers require a client thread identity', rx(String.raw`function @name@\(@e@,@t@=\`main\`,@n@=\k<e>,@r@=(?:\k<e>==null|null==\k<e>)\?void 0:(?:@K@|\(0,@M@\.@K2@\))\(\k<e>\)\)\{if\((?:\k<r>==null|null==\k<r>)\)throw Error\(\`Pending local composers require a client thread identity\`\)`)),
  fnExposure('threadView', ',allowMissingConversation:', rx(String.raw`function @name@\(@e@\)\{let (?:[\w$]+,)*?@t@=\(0,@c@\.c\)\(\d+\),\{shouldResume:@a@,allowMissingConversation:@b@,showUtilityBar:`)),
  // what a chat asks of the user, without its composer: the app's lazy panel of a request (its chunk is the composer's, loaded with the thread view's), and the atom of a chat's pending request
  varExposure('PendingRequestPanel', 'PendingRequestItemPanel', rx(String.raw`@name@=(?:@L@|\(0,@L2@\._\))\(async\(\)=>(?:\(await @G@\(async\(\)=>\{let\{PendingRequestItemPanel:@e@\}=await import\(\`\./pending-request-item-panel-[\w-]+\.js\`\);return\{PendingRequestItemPanel:\k<e>\}\},__vite__mapDeps\(\[[\d,]+\]\),import\.meta\.url\)\)\.PendingRequestItemPanel|\(await Promise\.all\(\[[^\]]*\]\)\.then\(@I@\.bind\(\k<I>,\`[\w$]+\`\)\)\)\.RoutedPendingRequestItemPanel)`)),
  varExposure('pendingRequest', '.requests.length', rx(String.raw`@name@=(?:@K@|\(0,@K2@\.[\w$]+\))\([\w$.]+,\(@e@,\{get:@t@\}\)=>\{if\((?:\k<e>==null|null==\k<e>)\)return null;let @n@=\{hostId:\k<t>\([\w$.]+,\k<e>\),threadId:\k<e>\},@r@=\k<t>\([\w$.]+,\k<n>\);if\((?:\k<r>==null\|\|\k<r>\.requests\.length===0&&\k<r>\.pendingRequest==null|null==\k<r>\|\|0===\k<r>\.requests\.length&&null==\k<r>\.pendingRequest)\)return null;`)),
  // and the app's client of a host, from a scope and a host's id: how its own opener of that host brings in a chat it has not opened this run (activateThreadSummary, ensureConversationFirstPage)
  fnOrExported('hostClient', 'AppServerManager RPC is unavai', rx(String.raw`function @name@\(@e@,@t@\)\{try\{var @n@=@w@\(\);let @r@=\k<e>\.get\(@a@,\k<t>\),@i@=\k<e>\.get\(@b@\);if\(\k<i>!=null&&\k<r>\.status!==\`disconnected\``), rx(String.raw`@name@:function\(@e@,@t@\)\{let @n@=\{stack:\[\],error:void 0,hasError:!1\};try\{let @a@,@r@=\k<e>\.get\([\w$.]+,\k<t>\),@i@=\k<e>\.get\([\w$.]+\);if\(null!=\k<i>&&\`disconnected\`!==\k<r>\.status`)),
  fnExposure('CodexButton', 'uniformAtMobile:', rx(String.raw`function @name@\(@e@\)\{(?:"use forget";)?let (?:[\w$]+,)*?@t@=\(0,@c@\.c\)\(\d+\)[,;][^{}]{0,60}?if\(\k<t>\[0\]!==\k<e>\)\{@s@=Symbol\.for\(\`react\.early_return_sentinel\`\);(?:bb0|[\w$]+):\{let(?: (?:[\w$]+,)+)?\{uniform:@a@,uniformAtMobile:@b@,unstyled:@u@,allowShrink:@d@,color:@f@,`)),
  fnOrExported('Switch', 'trackClassName:', rx(String.raw`function @name@\(@e@\)\{[^{}]{0,400}?\(\{checked:@a@,onChange:@b@,disabled:@c@,className:@d@,id:@i@,ariaLabel:@l@,size:@s@,tone:@t@,trackClassName:`), rx(String.raw`@name@:function\(@e@\)\{[^{}]{0,400}?\(\{checked:@a@,onChange:@b@,disabled:@c@,(?:focusableWhenDisabled:@fw@,)?className:@d@,id:@i@,ariaLabel:@l@,size:@s@,tone:@t@,trackClassName:`)),
  fnExposure('TextField', 'leadingControl:', rx(String.raw`function @name@\(@e@\)\{[^{}]{0,500}?\(\{autoSize:@a@,id:@b@,ref:@c@,type:@d@,leadingControl:`)),
  fnExposure('Menu', 'loadingContent:', rx(String.raw`function @name@\(@e@\)\{[^{}]{0,100}?\{triggerButton:@a@,disabled:@b@,children:@c@,loadingContent:@d@,modal:@m@,open:@o@,`)),
  varExposure('MenuParts', 'focusMenuItem:', rx(String.raw`@name@=\{focusMenuItem:@a@,Trigger:(?:@b@,Content:@c@,Item:@d@,|function\()`)),
  fnExposure('Dialog', 'triggerAsChild:', rx(String.raw`function @name@\(@e@\)\{[^{}]{0,900}?\(\{children:@a@,modal:@b@,(?:animateHeight:@ah@,)?autoFocusCloseButton:@c@,triggerContent:@d@,triggerAsChild:`)),
  {
    key: 'DialogParts',
    needle: 'iconBackgroundClassName:',
    // The dialog's Header, Body and Footer: three function declarations of one module, each found by its own destructured props.
    locate(text, { inits }) {
      const one = (re) => { const ms = only(re, text); return ms.length === 1 ? ms[0] : null; };
      const header = one(rx(String.raw`function @name@\(@e@\)\{[^{}]{0,80}?\{icon:@a@,title:@b@,subtitle:@c@,className:@d@,iconClassName:@f@,iconBackgroundClassName:@g@,iconVariant:`));
      const body = one(rx(String.raw`function @name@\(@e@\)\{[^{}]{0,80}?\{children:@a@,className:@b@,size:@s@,variant:@v@\}=\k<e>,@d@=(?:\k<v>===void 0|void 0===\k<v>)\?\`default\`:\k<v>(?:,[^{}]{0,40}?)?;if\(`));
      const footer = one(rx(String.raw`function @name@\(@e@\)\{[^{}]{0,80}?\{children:@a@,className:@b@,expandSingleButton:@x@,variant:`));
      if (!header || !body || !footer) return [];
      const close = Math.max(...[header, body, footer].map((m) => matchClose(text, text.indexOf('{', m.index + m[0].indexOf('(')))));
      return [hit(header.index, guarded([inits.after(close)?.name], objectOf([['Header', header.groups.name], ['Body', body.groups.name], ['Footer', footer.groups.name]])))];
    },
  },
  varExposure('SettingsSection', 'actionsAlignment:', rx(String.raw`@name@=Object\.assign\((?:@root@,\{Header:@h@,Content:@c@,Footer:@f@\}\)|function\(@e@\)\{let [^{}]{0,40}=\(0,@c2@\.c\)\(\d+\),\{children:@i@,id:@id@,className:@d@\}=\k<e>[^]{0,400}?\},\{Header:function\(@e2@\)\{[^{}]{0,80}?\{title:@g@,subtitle:@s@,actions:@h2@,actionsAlignment:)`)),
  fnOrExported('SettingsRow', 'labelSizing:', rx(String.raw`function @name@\(@e@\)\{[^{}]{0,80}?\{label:@a@,labelSizing:@b@,labelWeight:@c@,layout:@d@,description:@f@,control:@g@,controlSizing:`), rx(String.raw`@name@:function\(@e@\)\{[^{}]{0,80}?\{label:@a@,labelSizing:@b@,labelWeight:@c@,layout:@d@,description:@f@,control:@g@,controlSizing:`)),
  // A mod's page in the app's Settings (docs/design/systems.md S15, E0): the page frame, the card of a section's rows, and the settings
  // navigation's entry and group. Each by its destructured props, which are its own.
  fnExposure('SettingsPageFrame', 'stickyControls:', rx(String.raw`function @name@\(@e@\)\{let (?:[\w$]+,)*?@t@=[^{}]{0,700}?\(\{title:@a@,asset:@b@,backSlot:@c@,subtitle:@d@,children:@f@,fullWidth:@g@,contentClassName:`)),
  fnExposure('SettingsCard', 'contentOverflow:', rx(String.raw`function @name@\(@e@\)\{let (?:[\w$]+,)*?@t@=[^{}]{0,60}?,\{children:@a@,className:@b@,contentOverflow:@c@,dividers:@d@,variant:@f@,decoration:`)),
  fnOrExported('NavItem', 'excludeFromNavigation:', rx(String.raw`function @name@\(@e@\)\{let @t@=[^{}]{0,1200}?\(\{animatedIcon:@a@,icon:@b@,iconAssetSource:@c@,thumbnail:@d@,label:@f@,labelTrailing:`), rx(String.raw`@name@:function\(@e@\)\{let (?:[\w$]+,)*?@t@=[^{}]{0,1200}?\(\{animatedIcon:@a@,icon:@b@,iconAssetSource:@c@,thumbnail:@d@,label:@f@,labelTrailing:`)),
  fnOrExported('NavGroup', 'titleActionsLayout:', rx(String.raw`function @name@\(@e@\)\{let @t@=[^{}]{0,60}?,\{children:@a@,className:@b@,collapsed:@c@,menuRef:@d@,title:@f@,titleActions:@g@,titleActionsLayout:`), rx(String.raw`@name@:function\(@e@\)\{let (?:[\w$]+,)*?@t@=[^{}]{0,60}?,\{children:@a@,className:@b@,collapsed:@c@,menuRef:@d@,title:@f@,titleActions:@g@,titleActionsLayout:`)),
  fnExposure('Tooltip', '.tooltipContent', rx(String.raw`function @name@\(@e@\)\{[^{}]{0,160}?if\(\k<e>\.disabled\|\|(?:\k<e>\.tooltipContent==null|null==\k<e>\.tooltipContent)\)\{`)),
  fnExposure('Icon', 'legacyClassName:', rx(String.raw`function @name@\(@e@\)\{[^{}]{0,160}?\(\{className:@a@,icon:@b@,legacyClassName:@c@,size:@s@,\.\.\.@r@\}=\k<e>`)),
  // E7.2: the transcript's reveal registry (a RouteScope atom family keyed by conversation, which the transcript list fills with
  // {revealItem, revealResponseTextAnnotation}) and the function that registers in it; found by the reader beside it.
  {
    key: 'transcriptReveal',
    needle: '?.revealResponseTextAnnotation(',
    locate(text, ctx) {
      const { inits } = ctx;
      const __rs = transcriptRevealRspack(text, ctx); if (__rs.length) return __rs;   // rspack (25679)
      return only(rx(String.raw`function @register@\(@s@,@c@,@h@\)\{return \k<s>\.set\(@atom@,\k<c>,\k<h>\),\(\)=>\{\k<s>\.get\(\k<atom>,\k<c>\)===\k<h>&&\k<s>\.set\(\k<atom>,\k<c>,null\)\}\}function @read@\(@s2@,@c2@,@a@,@b@\)\{return \k<s2>\.get\(\k<atom>,\k<c2>\)\?\.revealResponseTextAnnotation\(\k<a>,\k<b>\)\?\?Promise\.resolve\(\)\}`), text)
        .map((m) => hit(m.index, guarded([inits.ofVar(m.groups.atom) ?? inits.around(m.index)?.name], objectOf([['atom', m.groups.atom, true], ['register', m.groups.register]]))));
    },
  },
  // E8.9: the right panel's width (scout E8-frame-slots §5.3), set as the app's own drag sets it: its ratio (`toRatio(width, mainWidth,
  // mode)`), persisted under the active pane's storage key (`persist`), the pane's width config (a RouteScope atom: its `storageKey`) and
  // whether the page's workspace is unified (another atom: the width mode). Each found by its own body; the atoms by the panel's reads.
  {
    key: 'panelWidth',
    needle: 'mainContentWidth:',
    locate(text, ctx) {
      const { inits } = ctx;
      const __rs = panelWidthRspack(text, ctx); if (__rs.length) return __rs;   // rspack (25679)
      const one = (re) => { const ms = only(re, text); return ms.length === 1 ? ms[0] : null; };
      const config = one(rx(String.raw`@name@=@W@\(@tb@,\(\{get:@e@\}\)=>\{let @t@=\k<e>\(@aR@\.activeTab\$\);return \k<e>\(@q@\)\?\?\(\k<t>==null\?\k<e>\(@z@\):\k<t>\.tabType\.paneWidth\?\.\(\k<t>\.props\)\)\?\?\k<e>\(@o@\)\}\)`));
      if (!config) return [];
      const unified = one(new RegExp(String.raw`(${ID})=(${ID})\(${esc(config.groups.name)}\),(${ID})=\2\((?<atom>${ID})\),[^]{0,600}?(${ID})=\3==null\?\`regular\`:\`unified\``, 'g'));
      if (!unified) return [];
      // shape 1 (21477): the helpers are declared beside the panel: `function P({mainContentWidth,storageKey,width,widthMode}){persist(key,toRatio(width,main,mode))}`
      const persist = one(rx(String.raw`function @name@\(\{mainContentWidth:@e@,storageKey:@t@,width:@n@,widthMode:@r@\}\)\{@kg@\(\k<t>,@ratio@\(\k<n>,\k<e>,\k<r>\)\)\}`));
      let at; let toRatio; let persistName; let readyAfter;
      if (persist) {
        at = persist.index; toRatio = persist.groups.ratio; persistName = persist.groups.name;
        readyAfter = matchClose(text, text.indexOf('{', persist.index + persist[0].indexOf(')')));
      } else {
        // shape 2 (22943): the helpers live in another chunk and are imported here (any local name): found by their calls in the panel's drag handler,
        // `P({mainContentWidth:W.get(),storageKey:C.storageKey,width:w,widthMode:M})` and `ratio.set(R(w,W.get(),M))`, one function, the same w, W and M
        const call = one(rx(String.raw`(?<![\w$.])@name@\(\{mainContentWidth:@total@\.get\(\),storageKey:@cfg@\.storageKey,width:@w@,widthMode:@mode@\}\)`));
        if (!call) return [];
        const { total, w, mode } = call.groups;
        const set = one(new RegExp(String.raw`(?<![\w$.])${ID}\.set\((?<toRatio>${ID})\(${esc(w)},${esc(total)}\.get\(\),${esc(mode)}\)\)`, 'g'));
        const fn = enclosingFunction(text, call.index);
        if (!set || !fn || set.index < fn.start || set.index > fn.end) return [];
        at = call.index; toRatio = set.groups.toRatio; persistName = call.groups.name; readyAfter = fn.end;
      }
      return [hit(at, guarded([inits.after(readyAfter > 0 ? readyAfter : at)?.name, inits.ofVar(config.groups.name) ?? inits.around(config.index)?.name],
        objectOf([['toRatio', toRatio], ['persist', persistName], ['config', config.groups.name, true], ['unified', unified.groups.atom, true]])))];
    },
  },
  // E8.9: a project group's "Show more" (scout E8-frame-slots §2.4): the app's own expander state, an AppScope atom of the groups shown
  // in full (`project:<id>`) and its setter (the button's own); found by the setter's body, and only when that setter is called with a
  // `project:` key of the group's (the E8 third review: a generic boolean-map setter alone is not enough).
  {
    key: 'sidebarShowAll',
    needle: ']:!0});',   // rspack writes `[t]:!0});` with no `return}let ` after it
    locate(text, ctx) {
      const { inits, file, corpus } = ctx;
      const __rs = sidebarShowAllRspack(text, ctx); if (__rs.length) return __rs;   // rspack (25679)
      // called with the group's key: `v=\`project:${a.projectId}\`` ... `set(scope,v,expanded)`, in this chunk (21477) or in a chunk that imports the setter (22943: the group is drawn in app-primary)
      const keyed = (t, set) => new RegExp(String.raw`(${ID})=\`project:\$\{${ID}\.projectId\}\`[^]{0,4000}?[^\w$]${esc(set)}\(${ID},\1,`).test(t);
      return only(rx(String.raw`function @set@\(@e@,@t@,@n@\)\{let @r@=\k<e>\.get\(@atom@\);if\(\k<n>===\(\k<r>\[\k<t>\]===!0\)\)return;if\(\k<n>\)\{\k<e>\.set\(\k<atom>,\{\.\.\.\k<r>,\[\k<t>\]:!0\}\);return\}let @i@=\{\.\.\.\k<r>\};delete \k<i>\[\k<t>\],\k<e>\.set\(\k<atom>,\k<i>\)\}`), text)
        .filter((m) => keyed(text, m.groups.set) || importersOf(corpus, file, m.groups.set, '`project:${').some((u) => keyed(corpus.text(u.file), u.local)))
        .map((m) => hit(m.index, guarded([inits.ofVar(m.groups.atom) ?? inits.around(m.index)?.name], objectOf([['set', m.groups.set], ['atom', m.groups.atom, true]]))));
    },
  },
  // layouts D9 (scout docs/research/layouts/wl2-d9-orders.md §3.3): what tells whether the user arranged a sidebar list by hand, the app's
  // effective (derived) atoms, never the persisted keys (an old `manual` without its version reads `updated_at`): the sort preferences
  // (chats' and projects' chats' modes), the pinned list's mode, and the project groups' order the user dragged
  {
    key: 'sidebarOrderState',
    needle: '`pinned-sidebar-sort-mode-v1`',
    locate(text, ctx) {
      const { inits } = ctx;
      const __rs = sidebarOrderStateRspack(text, ctx); if (__rs.length) return __rs;   // rspack (25679)
      const one = (re) => { const ms = only(re, text); return ms.length === 1 ? ms[0] : null; };
      const prefs = one(rx(String.raw`@persist@=@X@\(\`flat-project-sidebar-preferences-v1\`,@dflt@\),@legacy@=\k<X>\(\`codex-sidebar-sort-mode-v1\`,void 0\),@atom@=@U@\(@Q@,\(\{get:@e@\}\)=>\{let @t@=@norm@\(\k<e>\(\k<persist>\)\?\?@H@\(\`flat-project-sidebar-preferences-v1\`,\k<dflt>\),`));
      const pinned = one(rx(String.raw`@persist@=@X@\(\`pinned-sidebar-sort-mode-v1\`,\`manual\`\),@atom@=@U@\(@Q@,\(\{get:@e@\}\)=>\{let @t@=\k<e>\(\k<persist>\);return \k<t>===\`priority\`\?\`updated_at\`:\k<t>\?\?\`manual\`\}\)`));
      const orders = one(rx(String.raw`@chatP@=@X@\(\`unified-sidebar-chat-order-v1\`,@d1@\),@projP@=\k<X>\(\`unified-sidebar-project-order-v1\`,@d2@\),[^]{0,500}?@chat@=@U@\(@Q@,\(\{get:@e@\}\)=>\k<e>\(\k<chatP>\)\?\?\k<d1>\),@pinned@=\k<U>\(\k<Q>,\(\{get:\k<e>\}\)=>\{[^]{0,260}?\`unified-sidebar-pinned-order-v1\`[^]{0,1400}?\}\),@proj@=\k<U>\(\k<Q>,\(\{get:\k<e>\}\)=>\k<e>\(\k<projP>\)\?\?\k<d2>\)`));
      if (!prefs || !pinned || !orders) return [];
      const atoms = [prefs.groups.atom, pinned.groups.atom, orders.groups.proj];
      return [hit(pinned.index, guarded(atoms.map((a) => inits.ofVar(a)), objectOf([['prefs', atoms[0], true], ['pinnedSortMode', atoms[1], true], ['projectOrder', atoms[2], true]])))];
    },
  },
  // E8.9: the transcript's find bar (the app's own, Cmd+F): plain functions over RouteScope atoms. ThreadView `find(text)` does what the
  // app's own handler does: the conversation's domain, the query, open (the bar then searches the pending query). Each function is found by
  // its own body; the atoms come from the same matches.
  {
    key: 'threadFind',
    needle: '{selectDefaultTarget:',
    locate(text, ctx) {
      const { inits } = ctx;
      const __rs = threadFindRspack(text, ctx); if (__rs.length) return __rs;   // rspack (25679)
      const one = (re) => { const ms = only(re, text); return ms.length === 1 ? ms[0] : null; };
      const open = one(rx(String.raw`function @name@\(@e@,\{selectDefaultTarget:@t@=!0\}=\{\}\)\{let @n@=\k<e>\.get\(@target@\)\.orchestrationId;\k<t>&&\k<n>!=null&&@sel@\(\k<e>,\k<n>\),\k<e>\.set\(@open@,!0\)\}`));
      const close = one(rx(String.raw`function @name@\(@e@\)\{\k<e>\.get\(@domain@\)===\`file\`&&\k<e>\.get\(@ctl@\)\?\.focus\(\),@clear@\(\k<e>\),\k<e>\.set\(@open@,!1\),\k<e>\.set\(@query@,\`\`\),\k<e>\.set\(@results@,null\),\k<e>\.set\(@pending@,!1\),\k<e>\.set\(@active@,null\)\}`));
      const setDomain = one(rx(String.raw`function @name@\(@e@,@t@\)\{@clear@\(\k<e>\),\k<e>\.set\(@domain@,\k<t>\),\k<e>\.set\(@results@,null\),\k<e>\.set\(@pending@,!1\),\k<e>\.set\(@active@,null\)\}`));
      const setQuery = one(rx(String.raw`function @name@\(@e@,@t@\)\{if\(\k<t>\.trim\(\)\.length===0\)\{@clear@\(\k<e>\),\k<e>\.set\(@query@,\k<t>\),\k<e>\.set\(@results@,null\),\k<e>\.set\(@pending@,!1\),\k<e>\.set\(@active@,null\);return\}\k<e>\.set\(\k<query>,\k<t>\),\k<e>\.set\(\k<pending>,!0\)\}`))
        ?? one(rx(String.raw`function @name@\(@e@,@t@\)\{\k<t>\.trim\(\)\.length===0\?\(@clear@\(\k<e>\),\k<e>\.set\(@query@,\k<t>\),\k<e>\.set\(@results@,null\),\k<e>\.set\(@pending@,!1\),\k<e>\.set\(@active@,null\)\):\(\k<e>\.set\(\k<query>,\k<t>\),\k<e>\.set\(\k<pending>,!0\)\)\}`));
      const step = (dir) => one(rx(String.raw`function @name@\(@e@\)\{if\(\k<e>\.get\(@domain@\)===\`file\`\)\{@m@\(\k<e>,\`${dir}\`\);return\}`));
      const next = step('next'), previous = step('previous');
      if (!open || !close || !setDomain || !setQuery || !next || !previous) return [];
      const g = (m) => m.groups;
      // one store: the atoms the functions set are the same ones
      if (g(close).open !== g(open).open || g(close).domain !== g(setDomain).domain || g(close).query !== g(setQuery).query
        || g(close).results !== g(setDomain).results || g(close).active !== g(setDomain).active) return [];
      const last = Math.max(...[open, close, setDomain, setQuery, next, previous].map((m) => m.index));
      const end = matchClose(text, text.indexOf('{', last + text.slice(last).indexOf(')')));
      return [hit(open.index, guarded([inits.after(end)?.name], objectOf([['open', g(open).name], ['close', g(close).name], ['setDomain', g(setDomain).name],
        ['setQuery', g(setQuery).name], ['next', g(next).name], ['previous', g(previous).name],
        ['atoms', objectOf([['open', g(open).open, true], ['query', g(setQuery).query, true], ['domain', g(setDomain).domain, true], ['results', g(close).results, true], ['active', g(close).active, true]]), false]])))];
    },
  },
  // E7.2: the dynamic tool calls' renderers (a module-level list of {namespace, tool, render, ...} descriptors, found by its finder): a mod's
  // Step drawn by the framework (its presented items are dynamic tool calls).
  {
    key: 'dynamicToolRenderers',
    needle: 'continuesLiveActivityBetweenCalls===!0',
    locate(text, { inits }) {
      return only(rx(String.raw`function @find@\(@e@\)\{return @list@\.find\(@t@=>\k<t>\.namespace===\k<e>\.namespace&&\k<t>\.tool===\k<e>\.tool\)\}`), text)
        .map((m) => hit(m.index, guarded([inits.ofVar(m.groups.list) ?? inits.around(m.index)?.name], objectOf([['list', m.groups.list, true], ['find', m.groups.find]]))));
    },
  },
  // E7.2: the terminals' manager, the module singleton whose renderers map holds each session's renderer (its xterm terminal), keyed by
  // session id; found by its fields and the new right after the class.
  {
    key: 'terminalManager',
    needle: 'lastRenderedOutputBySessionId=new Map',
    locate(text, ctx) {
      const { inits } = ctx;
      const __rs = terminalManagerRspack(text, ctx); if (__rs.length) return __rs;   // rspack (25679)
      const out = [];
      for (const m of only(rx(String.raw`@cls@=class\{hostService=null;listeners=new Map;renderers=new Map;(?:${ID}=new Map;)*?lastRenderedOutputBySessionId=new Map;`), text)) {
        const open = m.index + m[0].indexOf('{');
        const end = matchClose(text, open);
        if (end < 0 || !text.slice(open, end).includes('getOrCreateRenderer(')) continue;
        const inst = new RegExp(`^,(${ID})=new ${m.groups.cls.replace(/\$/g, '\\$')}[;,})]`).exec(text.slice(end + 1, end + 80));
        if (inst) out.push(hit(m.index, guarded([inits.ofVar(inst[1]) ?? inits.around(m.index)?.name], inst[1])));
      }
      return out;
    },
  },
  // E7.2: the markdown renderer's default components ({a, code}) for a message's content, by its destructured options.
  fnExposure('markdownComponents', 'pluginMentionPresentation:', rx(String.raw`function @name@\(\{allowWideBlocks:@a@,conversationId:@b@,cwd:@c@,externalLinkAppearance:@d@,externalResourcePolicy:@f@,forceCodeBlockWordWrap:`)),
  // E7.7: the app's expandable activity row (icon, summary, accessory, disclosure, body): a mod's Step drawn as the app draws its own.
  fnOrExported('activityRow', 'headerClassName:', rx(String.raw`function @name@\(@e@\)\{let @t@=\(0,@c@\.c\)\(\d+\),[^{}]{0,120}?\(\{accessory:@a@,body:@b@,className:@d@,disclosure:@g@,headerClassName:@h@,icon:@i@,summary:@j@,\.\.\.@k@\}=\k<e>`), rx(String.raw`@name@:function\(@e@\)\{let (?:[\w$]+,)*?@t@=\(0,@c@\.c\)\(\d+\)[,;][^{}]{0,120}?\(\{accessory:@a@,body:@b@,className:@d@,disclosure:@g@,headerClassName:@h@,icon:@i@,summary:@j@,\.\.\.@k@\}=\k<e>`)),
  // H3 (public-hooks.md §3.14; scout H3-sidebar §1.4): the sidebar's group shell (its title, chevron, actions and collapse) and its list by
  // key (the app's own rows for chat keys), so a mod's section is drawn with the app's own parts, mounted or not.
  fnOrExported('SidebarGroup', 'collapsedStatusState:', rx(String.raw`function @name@\(@e@\)\{let @t@=\(0,@c@\.c\)\(\d+\),\{children:@a@,followingSections:@b@,collapsed:@d@,collapsedStatusState:`), rx(String.raw`@name@:function\(@e@\)\{let (?:[\w$]+,)*?@t@=\(0,@c@\.c\)\(\d+\),\{children:@a@,followingSections:@b@,collapsed:@d@,collapsedStatusState:`)),
  fnExposure('SidebarList', 'allowCodexThreadProjectDrag:', rx(String.raw`function @name@\(@e@\)\{(?:"use forget";)?let (?:[\w$]+,)*?@t@=\(0,@c@\.c\)\(\d+\),\{afterItemsNode:@a@,archiveGroup:@b@,allowCodexThreadProjectDrag:`)),
  fnOrExported('ComposerDropdown', '"data-composer-navigation-target":', rx(String.raw`function @name@\(@e@\)\{let @t@=[^{}]{0,60}?,\{"aria-label":@a@,"data-composer-navigation-target":@b@,children:@c@,(?:clearAction:@ca@,)?combobox:@d@,collapse:@f@,contentClassName:`), rx(String.raw`@name@:function\(@e@\)\{let (?:[\w$]+,)*?@t@=[^{}]{0,60}?,\{"aria-label":@a@,"data-composer-navigation-target":@b@,children:@c@,(?:clearAction:@ca@,)?combobox:@d@,collapse:@f@,contentClassName:`)),
  // E8.5, the palette's sources (mod-surfaces.md §3.2; a scout of 21477): cmdk's Command (its List,
  // Item, Input, Group, ... members), the app's own row, the sections the palette reads (an AppScope atom), cmdk's own state hook (the text
  // typed), the drill-in page stack (an atom), the builder of the app's async-result values (always shown, ranked last) and its shortcut chip.
  // (its members are what the locator requires: wherever it is located they are there, the palette's own list and groups among them)
  { ...varExposure('commandMenu', 'Separator:', rx(String.raw`@name@=Object\.assign\(@root@,\{List:@a@,Item:@b@,Input:@c@,Group:@d@,Separator:@e@,Dialog:@f@,Empty:(?:@g@,Loading:@h@\}\)|[^;]{0,500}?\),Loading:[\w$]+\.forwardRef\()`)),
    guarantees: Object.freeze(['List', 'Item', 'Input', 'Group', 'Separator', 'Dialog', 'Empty', 'Loading']) },
  fnOrExported('commandMenuItem', 'titleTooltipContent:', rx(String.raw`function @name@\(@e@\)\{let @t@=\(0,@c@\.c\)\(\d+\),[^{}]{0,200}?\(\{title:@a@,description:@b@,leftAccessory:@d@,LeftIcon:@f@,RightIcon:@g@,titleTooltipContent:`), rx(String.raw`@name@:function\(@e@\)\{let (?:[\w$]+,)*?@t@=\(0,@c@\.c\)\(\d+\)[,;][^{}]{0,200}?\(\{title:@a@,description:@b@,leftAccessory:@d@,LeftIcon:@f@,RightIcon:@g@,titleTooltipContent:`)),
  {
    key: 'commandMenuSections',
    needle: '.dependencies?',
    // the atom the section hook writes (`.set(atom, list => { … list.push(section) … })`), read where it is initialised
    locate: (text, { inits }) => only(rx(String.raw`\.set\(@atom@,@x@=>\{let @y@=!1,@z@=(?:\[\.\.\.\k<x>\]|\k<x>)\.map\(@w@=>\k<w>\.id===@e@\.id\?\(\k<y>=!0,\k<e>\):\k<w>\);return \k<y>\|\|\k<z>\.push\(\k<e>\)`), text)
      .map((m) => hit(m.index, guarded([inits.ofVar(m.groups.atom) ?? inits.around(m.index)?.name], m.groups.atom))),
  },
  {
    key: 'ComposerControllerContext',
    needle: 'useComposerController must be used within',
    // the React context a composer's controller is given in (its text, selection, mentions, document): read where the app's own hook reads
    // it, so a component outside a composer reads null where the hook would throw
    locate: (text, { inits }) => only(rx(String.raw`(?:@name@=|@name2@:)\(\)=>\{let @e@=\(0,@R@\.useContext\)\((?<ctx>[\w$]+(?:\.[\w$]+)?)\);if\(!\k<e>\)throw Error\(\`useComposerController must be used within a ComposerControllerScope\`\);return \k<e>\}`), text)
      .map((m) => hit(m.index, guarded([inits.ofVar(m.groups.ctx) ?? inits.around(m.index)?.name], m.groups.ctx))),
  },
  fnExposure('commandMenuState', 'useSyncExternalStore(', rx(String.raw`function @name@\(@e@\)\{let @t@=(?:@ctx@\(\)|[\w$]+\.useContext\([\w$]+\)),@n@=\(\)=>\k<e>\(\k<t>\.snapshot\(\)\);return @R@\.useSyncExternalStore\(\k<t>\.subscribe,\k<n>,\k<n>\)\}`)),
  {
    key: 'commandMenuPages',
    needle: 'searchPlaceholder:',
    // the page stack atom: the one push of a drill-in page in the app (`.set(atom, [...stack, {id, searchPlaceholder, title}])`)
    locate: (text, { inits }) => only(rx(String.raw`@set@\.set\((?<atom>[\w$]+(?:\.[\w$]+)?),\[\.\.\.@s@,\{id:@id@,searchPlaceholder:@p@,title:@t@\}\]\)`), text)
      .map((m) => hit(m.index, guarded([inits.ofVar(m.groups.atom) ?? inits.around(m.index)?.name], m.groups.atom))),
  },
  fnOrExported('commandMenuAsyncValue', 'command-menu-async-result:', rx(String.raw`function @name@\(@e@\)\{return\`\$\{@pfx@\}\$\{\k<e>\}\`\}function @n2@\(@e2@,@t2@\)\{return @t2@&&\k<e2>\.trim\(\)\.toLowerCase\(\)===`), rx(String.raw`@name@:function\(@e@\)\{return\`\$\{@pfx@\}\$\{\k<e>\}\`\}[^]{0,1500}?:function\(@e2@,@t2@\)\{return \k<t2>&&`)),
  fnOrExported('KeysLabel', 'keysLabel:', rx(String.raw`function @name@\(@e@\)\{let @t@=\(0,@c@\.c\)\(8\),\{keysLabel:@n@,variant:@r@,className:@i@\}=\k<e>`), rx(String.raw`@name@:function\(@e@\)\{let (?:[\w$]+,)*?@t@=\(0,@c@\.c\)\(8\),\{keysLabel:@n@,variant:@r@,className:@i@\}=\k<e>`)),
];

const NEEDLES = [...new Set([
  ...EXPOSURES.map((e) => e.needle),
  '`project:${',
  'flat-project-sidebar-preferences-v1', 'unified-sidebar-chat-order-v1',   // the sidebar order state's other two atoms (rspack: other modules, sidebarOrderState)   // a project group's key (the sidebar's show-all exposure: where its setter is called)
  ',statusLoading:',   // the identity props' (MCP_ROW_NEEDLE, below)
  ',alignOffset:',     // the model menu's (MODEL_MENU_NEEDLE, below)
  ',repositoryName:',  // the branch switcher's list (BRANCH_LIST_NEEDLE, below)
  ',allowPlayableMedia:',   // the markdown renderer's (MD_TEXT_NEEDLE, below)
  '.length,`chats`)',   // the conversations sidebar's group keys (SIDEBAR_GROUPS_NEEDLE, below)
  '<=960,',   // the narrow-window handler (deriveResponsiveSeam, below)
  'path:`/codex-mobile`,',   // the app's route tree (PAGE_ROUTE_NEEDLE, below)
  'let{primaryDestinations:',   // the destinations' provider (DESTINATIONS_NEEDLE, below)
  '?`rail-with-contextual-sidebar`:`rail-only`}',   // the rail's mode (RAIL_MODE_NEEDLE, below)
  'tabType.isVisible?.(',   // a tab's visibility (TAB_VISIBLE_NEEDLE, below)
  '?.target?.ownerDocument?.defaultView??window',   // the copy helper's (COPY_NEEDLE, below)
  ',getMarkdown:', '.copyWorkingDirectorySuccess))', '.getFollowUpContext(',   // where the thread actions' copies are from (ORIGIN_SITES, below)
  'of[`normal`,`fallback`])',   // the command dispatcher's (COMMAND_NEEDLE, below)
  ',canceledPendingFileAttachmentIds:',   // the attach factory's (ATTACH_NEEDLE, below)
  ',reviewFiles:',   // the review panel's git actions (REVIEW_ACTION_NEEDLE, below)
  '){case`github-cli`:',   // a pull request created (PR_CREATE_NEEDLE, below)
  '.jsxs=', LAZY_GUARD, 'Promise.resolve();if(', '[{id:`newTask`,', 'new Map([[`newTask`,', '"codex.command.importExternalAgent":', MENU_NEEDLE, LAUNCHER_NEEDLE, FILE_MENU_NEEDLE, WORKSPACE_FILE_MENU_NEEDLE, TAB_MENU_NEEDLE, MD_COMPONENTS_NEEDLE, MD_DIRECTIVES_NEEDLE,
])];

/** A captured name as seam text writes it: a `$` that a String.replace pattern could read (`$8`, `$&`) is spelt `\u0024`, the same identifier. */
export const safeNames = (text) => text.replace(/\$(?=[&`'$0-9<])/g, '\\u0024');

/** The text of an exposure block: lazy, cached getters on `globalThis.__codexmods.exports`, appended before the chunk's source-map comment. Never a change of behaviour. */
export function exposureText(entries) {
  // an object literal is parenthesised: after `=>` a bare `{` would be a block
  const body = entries.map(([k, expr]) => `d(${JSON.stringify(k)},()=>${safeNames(expr.startsWith('{') ? `(${expr})` : expr)})`).join(';');
  return `;(()=>{let x=(globalThis.__codexmods??={}).exports??={},d=(k,f)=>{let v;Object.defineProperty(x,k,{get:()=>v??=f(),configurable:!0,enumerable:!0})};${body}})();\n`;
}
/**
 * The same block for an rspack module, placed first in the module's body (the module's names are local to its factory): its own names cannot shadow a
 * module's (`x`, `d` are common minified names there), and the getters only run when read, after the module has run.
 */
export function moduleExposureText(entries) {
  const body = entries.map(([k, expr]) => `__cmD(${JSON.stringify(k)},()=>${safeNames(expr.startsWith('{') ? `(${expr})` : expr)})`).join(';');
  return `;(()=>{let __cmE=(globalThis.__codexmods??={}).exports??={},__cmD=(k,f)=>{let v;Object.defineProperty(__cmE,k,{get:()=>v??=f(),configurable:!0,enumerable:!0})};${body}})();`;
}
/** The keys a block defines. */
export const exposedKeys = (text) => [...text.matchAll(/(?:\bd|__cmD)\("([\w$]+)",\(\)=>/g)].map((m) => m[1]);

// ---------------------------------------------------------------------------------------------- the generic seams
const miss = (item, tried) => ({ item, tried });
const group = (id, seam, drafts, extra = {}) => ({ id, seam, drafts, ...extra });

/**
 * Exactly-once locate of a regex across the chunks holding `needle`. The regex is run only in a window around each occurrence of the needle (the needle is
 * part of what the regex matches), so a chunk that holds the needle as data (a message catalog) costs nothing.
 * @returns {{file, text, m}|{why}}
 */
function theOne(corpus, needle, re, what, { back = 240, forward = 480 } = {}) {
  const hits = [];
  for (const { file } of corpus.find(needle)) {
    const text = corpus.text(file); const seen = new Set();
    for (const needle1 of spellings(needle)) for (let i = text.indexOf(needle1); i >= 0; i = text.indexOf(needle1, i + needle1.length)) {
      const from = Math.max(0, i - back);
      for (const w of matches(text.slice(from, i + needle.length + forward), re)) {
        const at = from + w.index;
        if (at > i || at + w[0].length < i + needle.length || seen.has(at)) continue;
        seen.add(at);
        const m = [...w]; m.index = at; m.groups = w.groups; m.input = text;
        hits.push({ file, text, m, module: corpus.moduleAt?.(file, at) ?? null });   // a corpus without modules (a test's) is a Vite one
      }
    }
  }
  // one site: one match, or (rspack) the matches of one module, one in each chunk that holds a copy of it. The copies are minified each on its own,
  // so a deriver reads one copy at a time: `corpus.pass` picks the copy (derived once per copy, see `eachCopy`), `corpus.copies` records how many there are
  const sites = new Map();
  for (const h of hits) { const k = h.module ? `module:${h.module.id}` : `${h.file}@${h.m.index}`; if (!sites.has(k)) sites.set(k, []); sites.get(k).push(h); }
  if (sites.size === 1) {
    const copies = [...sites.values()][0].sort((a, b) => a.file.localeCompare(b.file));
    if (new Set(copies.map((c) => c.file)).size === copies.length) {
      corpus.copies = Math.max(corpus.copies ?? 1, copies.length);
      return copies[Math.min(corpus.pass ?? 0, copies.length - 1)];
    }
  }
  return { why: `${what}: ${hits.length} matches in renderer chunks${sites.size !== hits.length ? ` (${sites.size} modules)` : ''}, expected exactly 1` };
}

/**
 * A deriver's result in every copy of its site (rspack: one module in several chunks, each copy minified on its own): the deriver runs once per copy
 * (`corpus.pass`), and the drafts a later pass adds (another copy's file) take the chunk's role in their id. A copy that does not derive drops the group.
 * A Vite build has one copy of everything: one pass, the deriver's result unchanged.
 */
function eachCopy(corpus, derive) {
  corpus.pass = 0; corpus.copies = 1;
  const first = derive();
  const n = corpus.copies;
  if (!first.group || n === 1) return first;
  const key = (d) => `${d.file}\0${d.find}\0${d.text}`;
  const drafts = [...first.group.drafts]; const seen = new Set(drafts.map(key));
  for (let k = 1; k < n; k++) {
    corpus.pass = k;
    const r = derive();
    if (!r.group) { corpus.pass = 0; return { group: null, missing: r.missing.map((x) => ({ ...x, tried: `${x.tried} (copy ${k + 1} of ${n})` })) }; }
    for (const d of r.group.drafts) if (!seen.has(key(d))) { seen.add(key(d)); drafts.push({ ...d, id: `${d.id}@${role(d.file)}` }); }
  }
  corpus.pass = 0;
  return { ...first, group: { ...first.group, drafts } };
}

/**
 * The function whose `function` keyword starts at `p`, a declaration `function F(…){…}` or an expression `function(…){…}` (rspack inlines single-use
 * functions, `await async function(…){…}(…)`, and writes exports as `{key:function(…){…}}`): `{ name, start, open, close }` (`open` and `close` are its
 * body's braces), or null.
 */
function functionAt(text, p) {
  const m = /^function(?: ([\w$]+))?\(/.exec(text.slice(p, p + 80));
  if (!m) return null;
  const pc = matchClose(text, p + m[0].length - 1);
  if (pc < 0 || text[pc + 1] !== '{') return null;
  const close = matchClose(text, pc + 1);
  return close < 0 ? null : { name: m[1] ?? null, start: p, open: pc + 1, close };
}
/**
 * The function around `idx`, `{ name, start, end }`: the named declaration that holds it (scan.mjs), else the nearest `function` (an expression too)
 * before it whose body holds it. `innermost` skips the declaration lookup: the innermost function of either kind.
 */
function enclosingFn(text, idx, { innermost = false } = {}) {
  if (!innermost) { const named = enclosingFunction(text, idx); if (named) return named; }
  for (let from = idx, n = 0; n < 600; n++) {
    const p = text.lastIndexOf('function', from);
    if (p < 0) return null;
    from = p - 1;
    const f = functionAt(text, p);
    if (f && f.close > idx) return { name: f.name, start: p, end: f.close };
  }
  return null;
}
/**
 * A seam's edit of a function that keeps its behaviour for its callers under a wrapper (`body(orig)` is the wrapper's body, `orig` how it calls the app's
 * own). A declaration (`name`): the wrapper takes its name and the app's function is renamed `F__cm`. An expression (no name): the wrapper is made around
 * it, `(function(__cmW){return function(__cmA){…}})(function(…){…})`, two edits: the head, and the tail after its closing brace (the last characters of the
 * function, made long enough to occur once in the chunk). `rest` is what follows `function F(` in what the head anchors on, `restExpr` what follows `function(`
 * (an expression has no name, so it needs more to be unique); `more` is the text after `rest` that a declaration's find takes when it is not unique alone.
 * @returns {{edits: {find, text}[]}|{why}}
 */
function wrapFunction(text, { at, kw = '', name, rest, restExpr = rest, more = '', params = '__cmA', body }) {
  if (name) {
    const f = safeNames(name); let find = `${kw}function ${name}(${rest}`; let after = rest;
    // a short find (a minified name and its parameters) may occur in another module of the chunk: it takes the text that follows it
    if (occurrences(text, find) !== 1 && more) { find += more; after += more; }
    if (occurrences(text, find) !== 1) return { why: `\`${find}\` occurs ${occurrences(text, find)} times, expected exactly 1` };
    if (new RegExp(`(?<![\\w$])${esc(name)}__cm(?![\\w$])`).test(text)) return { why: `${name}__cm is already a name` };
    return { edits: [{ find, text: `${kw}function ${f}(${params}){${body(`${f}__cm`)}}${kw}function ${f}__cm(${after}` }] };
  }
  const find = `${kw}function(${restExpr}`;
  if (occurrences(text, find) !== 1) return { why: `\`${find}\` occurs ${occurrences(text, find)} times, expected exactly 1` };
  const fn = functionAt(text, at);
  if (!fn) return { why: 'the function expression was not found at its head' };
  const head = { find, text: `(function(__cmW){return ${kw}function(${params}){${body('__cmW')}}})(${kw}function(${restExpr}` };
  for (let k = 24; k <= 240; k += 24) {
    const tail = text.slice(fn.close - k + 1, fn.close + 1);
    if (fn.close - k + 1 <= at + find.length) break;
    if (occurrences(text, tail) === 1) return { edits: [head, { find: tail, text: `${tail})` }] };
  }
  return { why: 'the end of the function expression is not unique in the chunk' };
}
/** The drafts of a function seam's edits: the first keeps `id`, a tail edit is `<id>:end`. */
const wrapDrafts = (w, id, seam, file, why) => w.edits.map((e, i) => ({ id: i ? `${id}:end` : id, seam, file, op: 'replace-once', find: e.find, text: e.text, why }));

export function deriveJsxSeam(corpus) {
  const r = theOne(corpus, '.jsxs=', JSX_RE, 'JSX factory `X.Fragment=F,X.jsx=G,X.jsxs=G}`');
  if (r.why) return { group: null, missing: [miss('seam:jsx', r.why)] };
  const { ns, frag, factory } = r.m.groups; const f = factory;
  const text = `${ns}.Fragment=${frag},${ns}.jsx=${ns}.jsxs=function(__cmA,__cmB,__cmC){var __cmH=globalThis.__codexmods?.jsx;if(typeof __cmH!="function")return ${f}(__cmA,__cmB,__cmC);`
    + `try{var __cmR=__cmH(${f},__cmA,__cmB,__cmC);if(__cmR!=null)return __cmR}catch(__cmX){var __cmF=globalThis.__codexmods?.faults;__cmF&&(__cmF.jsx=(__cmF.jsx|0)+1)}return ${f}(__cmA,__cmB,__cmC)}}`;
  return { group: group('jsx', 'jsx', [{ id: 'seam-jsx', seam: 'jsx', file: r.file, op: 'replace-once', find: r.m[0], text, why: 'JSX seam: the renderer\'s JSX factory asks globalThis.__codexmods.jsx(factory, type, props, key) first; absent, throwing or empty, the factory runs unchanged' }]), missing: [] };
}

export function deriveLazySeam(corpus) {
  // an rspack renderer has no Vite preload helper (its lazy modules load through the webpack runtime): no lazy seam, and nothing missing.
  // Nothing in the framework sets the lazy hook (preload's `lazyHook` stays null), so no feature depends on it.
  if (corpus.rspack && !corpus.find(LAZY_GUARD).length) return { group: null, missing: [] };
  const r = theOne(corpus, 'Promise.resolve();if(', LAZY_RE, 'Vite preload helper');
  if (r.why) return { group: null, missing: [miss('seam:lazy', r.why)] };
  if (occurrences(r.text, LAZY_GUARD) !== 1) return { group: null, missing: [miss('seam:lazy', `the helper's chunk holds ${occurrences(r.text, LAZY_GUARD)} \`${LAZY_GUARD}\` events, expected exactly 1`)] };
  const { name, imp, deps, base, r: rr } = r.m.groups;
  const text = `${name}=function(${imp},${deps},${base}){var __cmH=globalThis.__codexmods?.lazy;if(typeof __cmH=="function"){var __cmI=${imp};${imp}=function(){return Promise.resolve(__cmI()).then(function(__cmM){`
    + `try{var __cmR=__cmH(String(__cmI),__cmM);return __cmR==null?__cmM:__cmR}catch(__cmX){var __cmF=globalThis.__codexmods?.faults;__cmF&&(__cmF.lazy=(__cmF.lazy|0)+1);return __cmM}})}}`
    + `let ${rr}=Promise.resolve();if(${deps}&&${deps}.length>0){${r.m.groups.tail ?? ''}`;
  return { group: group('lazy', 'lazy', [{ id: 'seam-lazy', seam: 'lazy', file: r.file, op: 'replace-once', find: r.m[0], text, why: 'lazy seam: the importer of each lazily loaded module is wrapped so globalThis.__codexmods.lazy(importerSource, module) may replace the module' }]), missing: [] };
}

export function deriveTapSeams(corpus) {
  const missing = [];
  const table = theOne(corpus, '[{id:`newTask`,', TAP_TABLE_RE, 'command descriptor table');
  const handlers = theOne(corpus, 'new Map([[`newTask`,', TAP_HANDLERS_RE, 'command handler table');
  const messages = theOne(corpus, '"codex.command.importExternalAgent":', TAP_MESSAGES_RE, 'command message table');
  for (const [k, r] of [['commands', table], ['handlers', handlers], ['messages', messages]]) if (r.why) missing.push(miss(`seam:tap:${k}`, r.why));
  if (missing.length) return { group: null, missing };
  const arr = (member) => `...((t)=>Array.isArray(t)?t:[])(globalThis.__codexmods?.taps?.${member})`;
  const drafts = [
    { id: 'seam-tap:commands', file: table.file, find: table.m[0], text: `${table.m.groups.name}=[${arr('commands')},{id:\`newTask\`,`, why: 'tap: entries from globalThis.__codexmods.taps.commands come before the app\'s command descriptors' },
    { id: 'seam-tap:handlers', file: handlers.file, find: handlers.m[0], text: `${handlers.m.groups.name}=new Map([${arr('handlers')},[\`newTask\`,`, why: 'tap: [id, handler] pairs from globalThis.__codexmods.taps.handlers come before the app\'s default handlers' },
    { id: 'seam-tap:messages', file: messages.file, find: messages.m[0], text: `${messages.m.groups.name}={...((t)=>t&&typeof t=="object"?t:{})(globalThis.__codexmods?.taps?.messages),...${messages.m.groups.base},"codex.command.importExternalAgent":`, why: 'tap: messages from globalThis.__codexmods.taps.messages, overridden by the app\'s own' },
  ].map((d) => ({ ...d, seam: 'tap', op: 'replace-once' }));
  return { group: group('taps', 'tap', drafts), missing: [] };
}

export function deriveMenuSeam(corpus) {
  const r = theOne(corpus, MENU_NEEDLE, MENU_RE, 'thread menu item builder `async function F({scope,target,actions,…,showForkInSidebar,…})`', { back: 480, forward: 40 });
  if (r.why) return { group: null, missing: [miss('seam:menus', r.why)] };
  const name = r.m.groups.name; const f = safeNames(name);
  const find = `async function ${name}({scope:`;
  if (occurrences(r.text, find) !== 1) return { group: null, missing: [miss('seam:menus', `\`${find}\` occurs ${occurrences(r.text, find)} times in ${r.file}, expected exactly 1`)] };
  if (new RegExp(`(?<![\\w$])${esc(name)}__cm(?![\\w$])`).test(r.text)) return { group: null, missing: [miss('seam:menus', `${name}__cm is already a name in ${r.file}`)] };
  // The builder keeps its name for its callers: a wrapper under that name awaits the original (renamed) and passes its items to the hook.
  const text = `async function ${f}(__cmA){var __cmR=await ${f}__cm(__cmA),__cmH=globalThis.__codexmods?.menuItems;if(typeof __cmH!="function")return __cmR;`
    + `try{var __cmO=__cmH(__cmA,__cmR);return Array.isArray(__cmO)?__cmO:__cmR}catch(__cmX){var __cmF=globalThis.__codexmods?.faults;__cmF&&(__cmF.menuItems=(__cmF.menuItems|0)+1);return __cmR}}`
    + `async function ${f}__cm({scope:`;
  return { group: group('menus', 'menu', [{ id: 'seam-menu', seam: 'menu', file: r.file, op: 'replace-once', find, text, why: 'menu seam: the items of a thread\'s menus (sidebar row, thread header) pass globalThis.__codexmods.menuItems(args, items); absent, throwing or not an array, the app\'s items show' }]), missing: [] };
}

export function deriveLauncherSeam(corpus) {
  const r = theOne(corpus, LAUNCHER_NEEDLE, LAUNCHER_RE, 'panel launcher filter `function F(list,{codexFeatureAccess,surface,target})`', { back: 400, forward: 40 });
  if (r.why) return { group: null, missing: [miss('seam:launcher', r.why)] };
  const name = r.m.groups.name; const f = safeNames(name);
  const find = `function ${name}(${r.m.groups.list},{codexFeatureAccess:`;
  if (occurrences(r.text, find) !== 1) return { group: null, missing: [miss('seam:launcher', `\`${find}\` occurs ${occurrences(r.text, find)} times in ${r.file}, expected exactly 1`)] };
  if (new RegExp(`(?<![\\w$])${esc(name)}__cm(?![\\w$])`).test(r.text)) return { group: null, missing: [miss('seam:launcher', `${name}__cm is already a name in ${r.file}`)] };
  // The filter keeps its name for its callers: a wrapper under that name gives the hook the list and {surface, target} first; the app's
  // filter (renamed) then applies to what it answered, so a mod's tool still needs the target among its kind's drop destinations.
  const text = `function ${f}(__cmA,__cmB){var __cmH=globalThis.__codexmods?.launcher;if(typeof __cmH=="function"){try{var __cmO=__cmH(__cmA,__cmB&&{surface:__cmB.surface,target:__cmB.target});if(Array.isArray(__cmO))__cmA=__cmO}`
    + `catch(__cmX){var __cmF=globalThis.__codexmods?.faults;__cmF&&(__cmF.launcher=(__cmF.launcher|0)+1)}}return ${f}__cm(__cmA,__cmB)}`
    + `function ${f}__cm(${r.m.groups.list},{codexFeatureAccess:`;
  return { group: group('launcher', 'launcher', [{ id: 'seam-launcher', seam: 'launcher', file: r.file, op: 'replace-once', find, text, why: 'launcher seam: the panels\' tool list passes globalThis.__codexmods.launcher(list, {surface, target}) before the app\'s filter; absent, throwing or not an array, the app\'s list' }]), missing: [] };
}

export function deriveFileMenuSeam(corpus) {
  const r = theOne(corpus, FILE_MENU_NEEDLE, FILE_MENU_RE, 'file tree menu builder `function F({isLoadingOpenTargets, …, targetPath, visibleTargets})`', { back: 40, forward: 400 });
  if (r.why) return { group: null, missing: [miss('seam:file-menu', r.why)] };
  // the builder keeps its name for its callers (synchronous, as the original): its items pass the menus hook with their kind
  // no items (no row under the pointer): the app shows no menu, and none is made
  const body = (orig) => `var __cmR=${orig}(__cmA),__cmH=globalThis.__codexmods?.menuItems;if(typeof __cmH!="function"||!Array.isArray(__cmR)||!__cmR.length)return __cmR;`
    + `try{var __cmO=__cmH(__cmA,__cmR,"file-tree");return Array.isArray(__cmO)?__cmO:__cmR}catch(__cmX){var __cmF=globalThis.__codexmods?.faults;__cmF&&(__cmF.menuItems=(__cmF.menuItems|0)+1);return __cmR}`;
  const w = wrapFunction(r.text, { at: r.m.index, name: r.m.groups.name ?? null, rest: '{isLoadingOpenTargets:', body });
  if (w.why) return { group: null, missing: [miss('seam:file-menu', `${w.why} in ${r.file}`)] };
  return { group: group('file-menu', 'menu', wrapDrafts(w, 'seam-menu:file-tree', 'menu', r.file, 'file menu seam: a file or folder row\'s menu items (the Files and Changes trees) pass globalThis.__codexmods.menuItems(args, items, "file-tree"); absent, throwing or not an array, the app\'s items show')), missing: [] };
}

export function deriveWorkspaceFileMenuSeam(corpus) {
  const r = theOne(corpus, WORKSPACE_FILE_MENU_NEEDLE, WORKSPACE_FILE_MENU_RE, 'file reference menu builder `function F(scope,{artifactNavigationTarget, …, path},githubUrl=null)`', { back: 60, forward: 400 });
  if (r.why) return { group: null, missing: [miss('seam:workspace-file-menu', r.why)] };
  const name = r.m.groups.name; const f = safeNames(name);
  const find = `function ${name}(${r.m.groups.e},{artifactNavigationTarget:`;
  if (occurrences(r.text, find) !== 1) return { group: null, missing: [miss('seam:workspace-file-menu', `\`${find}\` occurs ${occurrences(r.text, find)} times in ${r.file}, expected exactly 1`)] };
  if (new RegExp(`(?<![\\w$])${esc(name)}__cm(?![\\w$])`).test(r.text)) return { group: null, missing: [miss('seam:workspace-file-menu', `${name}__cm is already a name in ${r.file}`)] };
  // the builder keeps its name and its synchronous shape; its items pass the menus hook with the reference and the kind
  const text = `function ${f}(__cmA,__cmB,__cmC){var __cmR=${f}__cm(__cmA,__cmB,__cmC),__cmH=globalThis.__codexmods?.menuItems;if(typeof __cmH!="function"||!Array.isArray(__cmR)||!__cmR.length)return __cmR;`
    + `try{var __cmO=__cmH(__cmB,__cmR,"workspace-file");return Array.isArray(__cmO)?__cmO:__cmR}catch(__cmX){var __cmF=globalThis.__codexmods?.faults;__cmF&&(__cmF.menuItems=(__cmF.menuItems|0)+1);return __cmR}}`
    + `function ${f}__cm(${r.m.groups.e},{artifactNavigationTarget:`;
  return { group: group('workspace-file-menu', 'menu', [{ id: 'seam-menu:workspace-file', seam: 'menu', file: r.file, op: 'replace-once', find, text, why: 'file reference menu seam: the menu of a file referenced anywhere (a chip, a link, a tab, an attachment) passes globalThis.__codexmods.menuItems(reference, items, "workspace-file"); absent, throwing or not an array, the app\'s items show' }]), missing: [] };
}

export function deriveTabMenuSeam(corpus) {
  const r = theOne(corpus, TAB_MENU_NEEDLE, TAB_MENU_RE, 'panel tab menu builder `function F({scope,controller,onBeginRename,tab,placement,isSourceCurrent})`', { back: 200, forward: 40 });
  if (r.why) return { group: null, missing: [miss('seam:tab-menu', r.why)] };
  const { e, t } = r.m.groups;
  // the builder keeps its name and its shape (a list or a promise of one); its items pass the menus hook with its arguments and the kind
  const body = (orig) => `var __cmR=${orig}(__cmA),__cmH=globalThis.__codexmods?.menuItems;if(typeof __cmH!="function")return __cmR;`
    + `var __cmP=function(__cmI){if(!Array.isArray(__cmI)||!__cmI.length)return __cmI;try{var __cmO=__cmH(__cmA,__cmI,"tab");return Array.isArray(__cmO)?__cmO:__cmI}catch(__cmX){var __cmF=globalThis.__codexmods?.faults;__cmF&&(__cmF.menuItems=(__cmF.menuItems|0)+1);return __cmI}};`
    + `return __cmR&&typeof __cmR.then=="function"?__cmR.then(__cmP):__cmP(__cmR)`;
  const w = wrapFunction(r.text, { at: r.m.index, name: r.m.groups.name ?? null, rest: '{scope:', restExpr: `{scope:${e},controller:${t},onBeginRename:`, body });
  if (w.why) return { group: null, missing: [miss('seam:tab-menu', `${w.why} in ${r.file}`)] };
  return { group: group('tab-menu', 'menu', wrapDrafts(w, 'seam-menu:tab', 'menu', r.file, 'tab menu seam: a panel tab\'s menu items pass globalThis.__codexmods.menuItems(args, items, "tab"); absent, throwing or not an array, the app\'s items show')), missing: [] };
}

// ---------------------------------------------------------------------------------------------- identity props (H7v)
// Props an app component lacks to name what it shows, added at its call site (public-hooks.md §3.13): the component destructures its own
// props, so they are inert to it, and a binding names its subject only when they are there. No hook: a group that does not apply leaves
// its rows unnamed (presenting nothing), never named wrongly.
/** An MCP server's row on the MCP settings page: `(Row,{name:server.name??key,statusLoading:` (21477 plugins-settings `Ca`). */
export const MCP_ROW_RE = rx(String.raw`\(@ca@,\{name:@n@\.name\?\?@key@,statusLoading:`);
export const MCP_ROW_NEEDLE = ',statusLoading:';
/** The keys the identity props add (and the only ones a props edit may add: the pack tests hold it to them). */
export const PROPS_KEYS = Object.freeze(['serverKey', 'hostId', 'fromPlugin', 'serverReadOnly', 'pickerRow', 'gitRoot', 'hostConfig']);
/**
 * A call's props object (from its `{`), or null; `extra` when it could overwrite an identity key: it spreads, computes a key, or names one
 * (plain, quoted or shorthand).
 */
function propsAt(text, open) {
  if (text[open] !== '{') return null;
  const close = matchClose(text, open);
  if (close < 0) return null;
  const body = text.slice(open, close + 1);
  const named = (k) => new RegExp(`[{,]\\s*(?:${k}|"${k}"|'${k}'|\`${k}\`)\\s*[:,}]`).test(body);
  return { body, extra: /\.\.\./.test(body) || /[{,]\s*\[/.test(body) || PROPS_KEYS.some(named) };
}
/** Where an arrow function's expression body (from `b`) ends: a name or a group, then its calls, members and indexes. */
function exprEnd(text, b) {
  let i = b;
  for (let n = 0; n < 64 && i < text.length; n++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') { const e = matchClose(text, i); if (e < 0) return -1; i = e + 1; continue; }
    if (/[\w$.]/.test(c)) { i++; continue; }
    if (c === '?' && text[i + 1] === '.') { i += 2; continue; }
    break;
  }
  return i - 1;
}
/**
 * Is `name` bound again around position `at` of `text`, inside the function starting at `from`: a parameter of an arrow function whose body
 * holds `at`, or a declaration (`let`/`const`/`var`) or an assignment of it in such a body before `at`. Conservative where it reads text.
 */
function rebinds(text, from, at, name) {
  const n = esc(name);
  // an assignment of it anywhere before `at` (the function's own body included), however nested: refused
  if (new RegExp(`(?<![\\w$.])${n}\\s*(?:[-+*/%&|^]|\\*\\*|<<|>>>?|&&|\\|\\||\\?\\?)?=(?![=>])|(?:\\+\\+|--)${n}(?![\\w$])|(?<![\\w$.])${n}(?:\\+\\+|--)`).test(text.slice(from, at))) return true;
  for (let i = text.indexOf('=>', from); i >= 0 && i < at; i = text.indexOf('=>', i + 2)) {
    const b = i + 2;
    const end = text[b] === '{' ? matchClose(text, b) : exprEnd(text, b);
    if (end < at) continue;   // an arrow whose body does not hold `at`
    const params = text[i - 1] === ')' ? text.slice(text.lastIndexOf('(', i - 1), i) : (/([\w$]+)$/.exec(text.slice(Math.max(from, i - 64), i)) ?? [''])[0];
    if (new RegExp(`(?<![\\w$.])${n}(?![\\w$])`).test(params)) return true;
    if (new RegExp(`(?:let|const|var)\\s[^;]*?(?<![\\w$.])${n}(?![\\w$])`).test(text.slice(b, at))) return true;
  }
  return false;
}
export function deriveMcpRowProps(corpus) {
  const r = theOne(corpus, MCP_ROW_NEEDLE, MCP_ROW_RE, 'MCP server row call `(Row,{name:n.name??key,statusLoading:`', { back: 80, forward: 0 });
  if (r.why) return { group: null, missing: [miss('seam:props:mcp-row', r.why)] };
  const { ca, n, key } = r.m.groups; const text = r.text;
  const no = (why) => ({ group: null, missing: [miss('seam:props:mcp-row', why)] });
  // the server list: its own props destructured (`{creation, cwd, hostId, searchQuery, useActiveWorkspaceRoot}=props`), its host theirs
  const list = enclosingFn(text, r.m.index);
  const head = list ? new RegExp(`^function ${ID}\\((${ID})\\)\\{let (?:${ID},)*?${ID}=\\(0,${ID}\\.c\\)\\(\\d+\\),\\{creation:${ID},cwd:${ID},hostId:(${ID}),searchQuery:${ID},useActiveWorkspaceRoot:${ID}\\}=\\1[,;]`).exec(text.slice(list.start, list.start + 400)) : null;
  if (!head) return no('the server list\'s props (`{creation, cwd, hostId, searchQuery, useActiveWorkspaceRoot}=props`) not found at its start');
  const host = head[2];
  // the config row: the direct return of the list's map callback (`.map(e=>{let[key,server]=e;return(0,X.jsx)(Row,{`), nothing bound between
  const before = text.slice(Math.max(list.start, r.m.index - 120), r.m.index);
  const cb = new RegExp(`\\.map\\((${ID})=>\\{let\\[${esc(key)},${esc(n)}\\]=\\1;return\\(0,${ID}\\.jsx\\)$`).exec(before);
  if (!cb || [cb[1], key, n].includes(host)) return no('the config row is not the direct return of the server list\'s map callback, or its names meet the host\'s');
  if (rebinds(text, list.start + head[0].length, r.m.index, host)) return no(`the host's name ${host} is bound again around the config row`);
  const configProps = propsAt(text, r.m.index + `(${ca},`.length);
  if (!configProps || configProps.extra) return no('the config row\'s props are not one object, or already name an identity key or spread');
  // the plugins' servers ("From plugins"): the same row, the direct return of their map callback
  const plugin = new RegExp(`\\.map\\((${ID})=>\\(0,${ID}\\.jsx\\)\\(${esc(ca)},\\{name:\\1\\.name,statusLoading:`, 'g');
  const pm = [...text.slice(list.start, list.end).matchAll(plugin)];
  if (pm.length !== 1) return no(`the plugins' server row call occurs ${pm.length} times in the list, expected exactly 1`);
  const pe = pm[0][1];
  const pAt = list.start + pm[0].index + pm[0][0].indexOf(`(${ca},{`);
  if (pe === host || rebinds(text, list.start + head[0].length, pAt, host)) return no(`the host's name ${host} is bound again around the plugins' row`);
  const pluginProps = propsAt(text, pAt + `(${ca},`.length);
  if (!pluginProps || pluginProps.extra) return no('the plugins\' row\'s props are not one object, or already name an identity key or spread');
  const find2 = `(${ca},{name:${pe}.name,statusLoading:`;
  // the row forwards them to the settings row it draws (`SettingsRow{className, label, control}`, exactly), its props unbound until there
  const def = new RegExp(`function ${esc(ca)}\\((${ID})\\)\\{let (?:${ID},)*?${ID}=\\(0,${ID}\\.c\\)\\(\\d+\\),\\{name:${ID},`).exec(text);
  if (!def) return no(`${ca}'s props (\`function ${ca}(props){let t=(0,X.c)(n),{name:…}=props\`) not found`);
  const props = def[1];
  const rowEnd = (enclosingFunction(text, def.index + def[0].length) ?? { end: -1 }).end;
  const ge = new RegExp(`,\\{className:[\\\`"']max-sm:flex-col max-sm:items-stretch[\\\`"'],label:${ID},control:${ID}\\}\\)`, 'g');
  const gm = [...text.matchAll(ge)];
  if (gm.length !== 1 || gm[0].index < def.index || gm[0].index > rowEnd) return no(`the row's settings row (\`{className, label, control}\`) occurs ${gm.length} times, or not in ${ca}`);
  if (rebinds(text, def.index + def[0].length, gm[0].index, props)) return no(`${ca}'s props name ${props} is bound again around its settings row`);
  for (const f of [r.m[0], find2, gm[0][0]]) if (occurrences(text, f) !== 1) return no(`\`${f}\` occurs ${occurrences(text, f)} times in ${r.file}, expected exactly 1`);
  const why = 'identity props: an MCP server\'s row carries its config key and its host (serverKey, hostId; a plugin\'s server fromPlugin), forwarded with whether it is read only (a project\'s) to the settings row it draws';
  return { group: group('props:mcp-row', 'props', [
    { id: 'seam-props:mcp-row', seam: 'props', file: r.file, op: 'replace-once', find: r.m[0], text: safeNames(`(${ca},{serverKey:${key},hostId:${host},name:${n}.name??${key},statusLoading:`), why },
    { id: 'seam-props:mcp-row-plugin', seam: 'props', file: r.file, op: 'replace-once', find: find2, text: safeNames(`(${ca},{serverKey:${pe}.name,hostId:${host},fromPlugin:!0,name:${pe}.name,statusLoading:`), why },
    { id: 'seam-props:mcp-row-forward', seam: 'props', file: r.file, op: 'replace-once', find: gm[0][0],
      text: safeNames(`${gm[0][0].slice(0, -2)},serverKey:${props}.serverKey,hostId:${props}.hostId,fromPlugin:${props}.fromPlugin,serverReadOnly:${props}.isReadOnly})`), why },
  ]), missing: [] };
}
/**
 * The composer's model menu (21477 `ket`: `function M(e){let t=(0,X.c)(n),{align:…,alignOffset:…,…,lockedModelSlug:…,modelPickerTriggerConfig:…`):
 * its one call (in the composer's picker) is given the host whose catalog it lists, the `hostId` of the picker's own models request
 * (`{additionalAvailableModels:…,hostId:H,enabledReasoningEfforts:…}`), and the label of each of its rows
 * (`label:(0,X.jsx)(Label,{model:m.model,displayName:m.displayName,`) says it is a row (`pickerRow`): the menu's other labels (its trigger,
 * its slider) carry the same props (public-hooks.md §3.13, H7z).
 */
export const MODEL_MENU_RE = rx(String.raw`function(?: @menu@)?\(@e@\)\{let (?:${ID},)*?@t@=\(0,@c@\.c\)\(\d+\),\{align:@n@,alignOffset:`);
export const MODEL_MENU_NEEDLE = ',alignOffset:';
export function deriveModelMenuProps(corpus) {
  const hits = [];
  for (const { file } of corpus.find(MODEL_MENU_NEEDLE)) {
    const text = corpus.text(file);
    for (const w of matches(text, MODEL_MENU_RE)) {
      const head = text.slice(w.index, w.index + 900);
      if (/[{,]lockedModelSlug:[\w$]+[,}]/.test(head) && /[{,]modelPickerTriggerConfig:[\w$]+[,}]/.test(head)) hits.push({ file, text, m: w, module: corpus.moduleAt(file, w.index) });
    }
  }
  const no = (why) => ({ group: null, missing: [miss('seam:props:model-menu', why)] });
  // one site: one match, or (rspack) the matches of one module, one in each chunk that holds a copy of it (see `theOne`)
  const sites = new Map();
  for (const h of hits) { const k = h.module ? `module:${h.module.id}` : `${h.file}@${h.m.index}`; if (!sites.has(k)) sites.set(k, []); sites.get(k).push(h); }
  const copies = sites.size === 1 ? [...sites.values()][0].sort((a, b) => a.file.localeCompare(b.file)) : [];
  if (copies.length === 0 || new Set(copies.map((c) => c.file)).size !== copies.length) return no(`model menu \`function M(e){…{align:…,alignOffset:…,lockedModelSlug:…,modelPickerTriggerConfig:\`: ${hits.length} matches in renderer chunks${sites.size !== hits.length ? ` (${sites.size} modules)` : ''}, expected exactly 1`);
  corpus.copies = Math.max(corpus.copies ?? 1, copies.length);
  const { file, text, m, module: mod } = copies[Math.min(corpus.pass ?? 0, copies.length - 1)];
  // its one call: props that carry its trigger's config and its locked model, none an identity key nor a spread. Where the menu is a named function
  // (rolldown) the call is in its chunk; where it is an export (rspack, `{key:function(e){…}}`) the call is `(0,X.jsx)(R.key,{align:…})` in a module
  // that requires its own, in one chunk of all that hold a copy of the menu (the copies of the menu are edited each, the call once)
  let menu = m.groups.menu; let cfile = file; let ctext = text;
  if (menu === undefined) {
    const key = /[{,]([\w$]+):$/.exec(text.slice(Math.max(0, m.index - 40), m.index))?.[1];
    if (!key || !mod) return no('the menu is a function expression that is not an export of its module');
    const callers = [];
    for (const c of copies) {
      const modules = corpus.modules(c.file);
      for (const x of c.text.matchAll(new RegExp(`\\((${ID})\\.${esc(key)},\\{align:`, 'g'))) {
        const cm = modules?.find((y) => y.open < x.index && x.index < y.close); const req = cm?.params.split(',')[2];
        if (req && new RegExp(`(?<![\\w$.])${esc(x[1])}=${esc(req)}\\("${esc(mod.id)}"\\)`).test(c.text.slice(cm.open, cm.close))) callers.push({ file: c.file, text: c.text, ns: x[1] });
      }
    }
    if (callers.length !== 1) return no(`the menu's call (\`(R.${key},{align:\`) in a module that requires its own: ${callers.length}, expected exactly 1`);
    menu = `${callers[0].ns}.${key}`; cfile = callers[0].file; ctext = callers[0].text;
  }
  const call = `(${menu},{align:`;
  if (occurrences(ctext, call) !== 1) return no(`\`${call}\` occurs ${occurrences(ctext, call)} times in ${cfile}, expected exactly 1`);
  const at = ctext.indexOf(call);
  const props = propsAt(ctext, at + `(${menu},`.length);
  if (!props || props.extra || !/[{,]modelPickerTriggerConfig:/.test(props.body) || !/[{,]lockedModelSlug:/.test(props.body)) return no('the menu\'s call has not one props object with its trigger\'s config and locked model, or it already names an identity key or spreads');
  // the host: the picker's own models request, in the function that makes the call, its name declared there and not bound again
  const fn = enclosingFn(ctext, at);
  if (!fn) return no('the function that calls the menu was not found');
  const body = ctext.slice(fn.start, at);
  // `{additionalAvailableModels:…,hostId:H,enabledReasoningEfforts:…}` (22943), `{additionalAvailableModels:…,enabledReasoningEfforts:…,hostId:H}` (25679)
  const reqs = [...body.matchAll(new RegExp(`\\{additionalAvailableModels:${ID},(?:hostId:(${ID})|enabledReasoningEfforts:[^,}]*,hostId:(${ID}))(?=[,}])`, 'g'))];
  if (reqs.length !== 1) return no(`the picker's models request (\`{additionalAvailableModels, hostId, enabledReasoningEfforts}\`) occurs ${reqs.length} times before the call, expected exactly 1`);
  const host = reqs[0][1] ?? reqs[0][2];
  const decl = new RegExp(`(?:let |,)${esc(host)}=(?!=)`).exec(body);
  if (!decl) return no(`the host's name ${host} is not declared in the picker`);
  const declAt = fn.start + decl.index + decl[0].length;
  if (rebinds(ctext, declAt, at, host)) return no(`the host's name ${host} is bound again before the menu's call`);
  // a row's label, in the menu's own function: once
  const own = enclosingFn(text, m.index + m[0].length);
  if (!own) return no('the menu\'s own function was not found');
  const rows = [...text.slice(own.start, own.end).matchAll(new RegExp(`label:\\(0,${ID}\\.jsx\\)\\((${ID}(?:\\.${ID})?),\\{model:(${ID})\\.model,displayName:\\2\\.displayName,`, 'g'))];
  if (rows.length !== 1) return no(`a row's label (\`label:(0,X.jsx)(Label,{model:m.model,displayName:m.displayName,\`) occurs ${rows.length} times in the menu, expected exactly 1`);
  const rowFind = rows[0][0];
  if (occurrences(text, rowFind) !== 1) return no(`\`${rowFind}\` occurs ${occurrences(text, rowFind)} times in ${file}, expected exactly 1`);
  const rowProps = propsAt(text, own.start + rows[0].index + rowFind.lastIndexOf('{'));
  if (!rowProps || rowProps.extra) return no('a row\'s label has not one props object, or it already names an identity key or spreads');
  const why = 'identity props: the composer\'s model menu carries the host whose catalog it lists (hostId), and each of its rows\' labels says it is a row (pickerRow)';
  return { group: group('props:model-menu', 'props', [
    { id: 'seam-props:model-menu', seam: 'props', file: cfile, op: 'replace-once', find: call, text: safeNames(`(${menu},{hostId:${host},align:`), why },
    { id: 'seam-props:model-row', seam: 'props', file, op: 'replace-once', find: rowFind, text: safeNames(rowFind.replace(/\{model:/, '{pickerRow:!0,model:')), why },
  ]), missing: [] };
}
/**
 * The composer's branch switcher's list (21477 git-branch-switcher `un`: `function S(e){let t=(0,X.c)(n),{currentBranch:…,cwd:…,gitRoot:G,
 * hostConfig:H,…}=e`, its one call `(List,{branches:…,repositoryName:…,`): the list is given the repository it lists and its host (gitRoot,
 * hostConfig), so its rows name their Branch by them, never by the chat's sidebar project (H7x review 1). The branch pickers that name no
 * repository (a comparison's base) stay unnamed.
 */
export const BRANCH_LIST_RE = rx(String.raw`\((?<list>${ID}(?:\.${ID})?),\{branches:@b@,repositoryName:@n@,`);
export const BRANCH_LIST_NEEDLE = ',repositoryName:';
export function deriveBranchListProps(corpus) {
  const r = theOne(corpus, BRANCH_LIST_NEEDLE, BRANCH_LIST_RE, 'branch switcher\'s list call `(List,{branches:…,repositoryName:…,`', { back: 40, forward: 40 });
  const no = (why) => ({ group: null, missing: [miss('seam:props:branch-list', why)] });
  if (r.why) return no(r.why);
  const { list } = r.m.groups; const text = r.text;
  const fn = enclosingFn(text, r.m.index);
  const head = fn ? new RegExp(`^function ${ID}\\((${ID})\\)\\{let (?:${ID},)*?${ID}=\\(0,${ID}\\.c\\)\\(\\d+\\),\\{currentBranch:${ID},cwd:${ID},gitRoot:(${ID}),hostConfig:(${ID})[,}][^]*?\\}=\\1[,;]`).exec(text.slice(fn.start, fn.start + 600)) : null;
  if (!head) return no('the switcher\'s props (`{currentBranch, cwd, gitRoot, hostConfig, …}=props`) not found at its start');
  const [, , root, host] = head;
  for (const name of [root, host]) if (rebinds(text, fn.start + head[0].length, r.m.index, name)) return no(`the switcher's name ${name} is bound again before the list's call`);
  if (occurrences(text, r.m[0]) !== 1) return no(`\`${r.m[0]}\` occurs ${occurrences(text, r.m[0])} times in ${r.file}, expected exactly 1`);
  const props = propsAt(text, r.m.index + `(${list},`.length);
  if (!props || props.extra) return no('the list\'s call has not one props object, or it already names an identity key or spreads');
  const why = 'identity props: the branch switcher\'s list carries the repository it lists and its host (gitRoot, hostConfig)';
  return { group: group('props:branch-list', 'props', [{ id: 'seam-props:branch-list', seam: 'props', file: r.file, op: 'replace-once', find: r.m[0],
    text: safeNames(r.m[0].replace('{branches:', `{gitRoot:${root},hostConfig:${host},branches:`)), why }]), missing: [] };
}
/**
 * The markdown renderer every markdown site renders through (21477 `I_d`: `function F(e){let t=(0,X.c)(n),{allowBasicHtml:…,
 * allowPlayableMedia:…,renderText:…}=e`): its props pass `globalThis.__codexmods.markdownText(props, renderText)` first, whose answer, a
 * function, is the `renderText` its text tokens are drawn with, or an object whose `renderText` and `tokens` replace the site's (its code
 * masked) (public-hooks.md §3.14, H7u); anything else, or a throw, keeps the site's.
 */
export const MD_TEXT_RE = rx(String.raw`function(?: @name@)?\(@e@\)\{let (?:${ID},)*?@t@=\(0,@c@\.c\)\(\d+\),\{allowBasicHtml:@n@,allowPlayableMedia:`);
export const MD_TEXT_NEEDLE = ',allowPlayableMedia:';
export function deriveMarkdownTextSeam(corpus) {
  const r = theOne(corpus, MD_TEXT_NEEDLE, MD_TEXT_RE, 'markdown renderer `function F(e){let t=(0,X.c)(n),{allowBasicHtml:…,allowPlayableMedia:`', { back: 120, forward: 0 });
  if (r.why) return { group: null, missing: [miss('seam:markdown:text', r.why)] };
  const { name, e } = r.m.groups;
  const no = (why) => ({ group: null, missing: [miss('seam:markdown:text', why)] });
  const head = r.text.slice(r.m.index, r.m.index + 1200);
  if (!/[{,]renderText:[\w$]+[,}]/.test(head) || !/[{,]getDefaultComponents:[\w$]+[,}]/.test(head)) return no(`${name ?? 'the renderer'}'s props hold no renderText and getDefaultComponents`);
  const body = (orig) => `var __cmH=globalThis.__codexmods?.markdownText;if(typeof __cmH!="function"||!__cmA||typeof __cmA!="object")return ${orig}(__cmA);`
    + `try{var __cmO=__cmH(__cmA,__cmA.renderText);if(typeof __cmO=="function"){if(__cmO!==__cmA.renderText)__cmA=Object.assign({},__cmA,{renderText:__cmO})}`
    + `else if(__cmO&&typeof __cmO=="object"){var __cmP={};if(typeof __cmO.renderText=="function")__cmP.renderText=__cmO.renderText;if(Array.isArray(__cmO.tokens))__cmP.tokens=__cmO.tokens;__cmA=Object.assign({},__cmA,__cmP)}}`
    + `catch(__cmX){var __cmF=globalThis.__codexmods?.faults;__cmF&&(__cmF.markdown=(__cmF.markdown|0)+1)}return ${orig}(__cmA)`;
  // an expression (rspack's `{T:function(e){…}}` export) has no name: its head is the whole match, which holds its compiler cache and props
  const w = wrapFunction(r.text, { at: r.m.index, name: name ?? null, rest: `${e}){`, restExpr: r.m[0].slice('function('.length), body });
  if (w.why) return no(`${w.why} in ${r.file}`);
  return { group: group('markdown-text', 'markdown', wrapDrafts(w, 'seam-markdown:text', 'markdown', r.file,
    'markdown text seam: the markdown renderer\'s props pass globalThis.__codexmods.markdownText(props, renderText); a function it answers draws the text tokens; anything else, or a throw, the site\'s own')), missing: [] };
}

/**
 * The conversations sidebar's groups (layouts.md §4.1; scout wl2-groups-footer.md §1.4): the keys of the groups it shows (`pinned`, `agents`,
 * `threads`, `chats`, `custom:<id>`) as the app orders them, before its drag controller, its lists and its shortcuts read them (22943
 * ``let Vt=Oe.filter(Bt);d&&Vt.splice(0,Vt.length,`chats`);``: the unread view's splice says it is that list) pass
 * `globalThis.__codexmods.sidebarGroups(keys)` first; a permutation answered is used (a fresh array: the unread view splices it next),
 * anything else or a throw keeps the app's.
 */
export const SIDEBAR_GROUPS_RE = rx(String.raw`let @vt@=@oe@\.filter\(@bt@\);@d@&&\k<vt>\.splice\(0,\k<vt>\.length,\`chats\`\)[;,]`);
export const SIDEBAR_GROUPS_NEEDLE = '.length,`chats`)';
export function deriveSidebarGroupsSeam(corpus) {
  const r = theOne(corpus, SIDEBAR_GROUPS_NEEDLE, SIDEBAR_GROUPS_RE, 'the sidebar\'s groups `let V=O.filter(B);d&&V.splice(0,V.length,`chats`);`', { back: 120, forward: 1 });
  if (r.why) return { group: null, missing: [miss('seam:sidebar-groups', r.why)] };
  const { vt, oe, bt } = r.m.groups;
  const head = `let ${vt}=${oe}.filter(${bt});`;
  const text = r.m[0].replace(head, `let ${vt}=(function(__cmK){var __cmH=globalThis.__codexmods?.sidebarGroups;if(typeof __cmH!="function")return __cmK;`
    + `try{var __cmO=__cmH(__cmK);return Array.isArray(__cmO)&&__cmO.length===__cmK.length&&__cmO.every(function(__cmE){return __cmK.indexOf(__cmE)>=0})?__cmO.slice():__cmK}`
    + `catch(__cmX){var __cmF=globalThis.__codexmods?.faults;__cmF&&(__cmF.sidebarGroups=(__cmF.sidebarGroups|0)+1);return __cmK}})(${oe}.filter(${bt}));`);
  return { group: group('sidebar-groups', 'sidebar-groups', [{ id: 'seam-sidebar-groups', seam: 'sidebar-groups', file: r.file, op: 'replace-once', find: r.m[0], text,
    why: 'sidebar groups seam: the conversations sidebar\'s group keys pass globalThis.__codexmods.sidebarGroups(keys) before the app reads them; a permutation answered is used, anything else or a throw the app\'s own' }]), missing: [] };
}

/**
 * A tab's visibility (layouts.md §4.1; scout wl2-tab-kinds.md §4.1): the panels' one read of a kind's `isVisible`, made with the scope only
 * (22943 `function g8r(e,t){return(t.workspaceKey==null||…)&&t.tabType.isVisible?.(e)!==!1}`), passes the tab too, so a kind's wrapper can
 * hide one panel's tabs and keep a tab that needs the user (the app's own kinds take the scope and ignore a second argument). No hook.
 */
export const TAB_VISIBLE_RE = rx(String.raw`function @fn@\(@e@,@t@\)\{return\((?:\k<t>\.workspaceKey==null|null==\k<t>\.workspaceKey)\|\|\k<t>\.workspaceKey===\k<e>\.value\.persistentWorkspace\?\.key\)&&\k<t>\.tabType\.isVisible\?\.\(\k<e>\)!==!1\}`);
export const TAB_VISIBLE_NEEDLE = 'tabType.isVisible?.(';
export function deriveTabVisibleSeam(corpus) {
  const r = theOne(corpus, TAB_VISIBLE_NEEDLE, TAB_VISIBLE_RE, 'a tab\'s visibility `function F(e,t){return(t.workspaceKey==null||…)&&t.tabType.isVisible?.(e)!==!1}`', { back: 200, forward: 40 });
  if (r.why) return { group: null, missing: [miss('seam:tab-visible', r.why)] };
  const { e, t } = r.m.groups;
  const text = r.m[0].replace(`${t}.tabType.isVisible?.(${e})!==!1}`, `${t}.tabType.isVisible?.(${e},${t})!==!1}`);
  return { group: group('tab-visible', 'tab-visible', [{ id: 'seam-tab-visible', seam: 'tab-visible', file: r.file, op: 'replace-once', find: r.m[0], text,
    why: 'tab visible seam: the panels ask a kind\'s isVisible with the tab as well as the scope (the app\'s own kinds ignore it)' }]), missing: [] };
}

/**
 * The workspace column's narrow-window handler (layouts.md WL4d, D12; scout wl4-workspace.md §3.3): on each change of the shell's width,
 * and once when a column mounts, it asks `globalThis.__codexmods.responsive({width, scope})` first (22943 ``Ut=e=>{let{width:t}=e;P.set(t);
 * let n=t<=960,r=t<=iRt,…``, 21477 `Yt`); `true` means the framework's allocator owns the window's responsive arrangement now and the
 * handler returns before it reads or writes anything (its crossing memory, the app's remembered panel); anything else, or a throw, the
 * app's thresholds as it wrote them.
 */
export const RESPONSIVE_RE = rx(String.raw`(?:@h@=@e@=>\{let\{width:@t@\}=\k<e>;@P@\.set\(\k<t>\);let @n@=\k<t><=960,@r@=\k<t><=@lim@,@i@=\k<n>!==@me@\.current,@a@=\k<r>!==@he@\.current;if\(\k<me>\.current=\k<n>,\k<he>\.current=\k<r>,!\k<i>&&!\k<a>\)return;let @s@=@E@&&\k<a>&&@o@\.get\(@auto@\),`
  + String.raw`|@h2@=@e2@=>\{let\{width:@t2@,workspaceWidth:@ww@\}=\k<e2>;@P2@\.set\(\k<t2>\);let @l2@=null==\k<ww>\?@m1@\.current:\k<ww><=960,@a2@=null==\k<ww>\?@m2@\.current:\k<ww><=720,@r2@=\k<t2><=720,@i2@=\k<l2>!==\k<m1>\.current,@o2@=\k<a2>!==\k<m2>\.current,@s2@=\k<r2>!==@m3@\.current;if\(\k<m1>\.current=\k<l2>,\k<m2>\.current=\k<a2>,\k<m3>\.current=\k<r2>,!\k<i2>&&!\k<o2>&&!\k<s2>\)return;let @d2@=@E2@&&\k<s2>&&@sc@\.get\()`);
export function deriveResponsiveSeam(corpus) {
  const r = theOne(corpus, '<=960,', RESPONSIVE_RE, 'the narrow-window handler `H=e=>{let{width:t}=e;P.set(t);let n=t<=960,…`', { back: 120, forward: 400 });
  if (r.why) return { group: null, missing: [miss('seam:responsive', r.why)] };
  const g = r.m.groups;
  const cut = (head, scope, arg) => ({ head, text: `${head}var __cmH=globalThis.__codexmods?.responsive;if(typeof __cmH=="function"){try{if(__cmH({${arg}scope:${scope}})===!0)return}`
    + `catch(__cmX){var __cmF=globalThis.__codexmods?.faults;__cmF&&(__cmF.responsive=(__cmF.responsive|0)+1)}}` });
  let c;
  if (g.h !== undefined) {
    // the second threshold is the app's 720, initialised once in the same chunk
    if (occurrences(r.text, `${g.lim}=720`) !== 1) return { group: null, missing: [miss('seam:responsive', `the handler's second limit ${g.lim} is not initialised once to 720 in ${r.file}`)] };
    c = cut(`${g.h}=${g.e}=>{let{width:${g.t}}=${g.e};${g.P}.set(${g.t});`, g.o, `width:${g.t},`);
  } else {
    // rspack (25679): the column's width arrives with the shell's (`{width, workspaceWidth}`), the limits (960 on the column, 720 on the shell) are inline
    c = cut(`${g.h2}=${g.e2}=>{let{width:${g.t2},workspaceWidth:${g.ww}}=${g.e2};${g.P2}.set(${g.t2});`, g.sc, `width:${g.t2},workspaceWidth:${g.ww},`);
  }
  if (!r.m[0].startsWith(c.head)) return { group: null, missing: [miss('seam:responsive', `the handler's head in ${r.file}`)] };
  const text = c.text + r.m[0].slice(c.head.length);
  return { group: group('responsive', 'responsive', [{ id: 'seam-responsive', seam: 'responsive', file: r.file, op: 'replace-once', find: r.m[0], text,
    why: 'responsive seam: the narrow-window handler asks globalThis.__codexmods.responsive({width, scope}) first; true: the framework\'s allocator owns the arrangement, anything else or a throw the app\'s thresholds' }]), missing: [] };
}

/**
 * The framework's route for a mod's page (layouts.md D7, WL5a; scout docs/research/layouts/wl5-pages.md §1.2): the app's route tree is built
 * once at module load, its first navigation goes to a persisted `initialRoute` before anything else runs, and a path with no route blanks
 * the window. So the route is written into the tree beside the app's `/codex-mobile` (22943 ``,(0,Q.jsx)(H,{path:`/codex-mobile`,element:
 * (0,Q.jsx)(hM,{})})``), its element the kernel's `__codexmods.PageRoute`, which draws the runtime's page host once it is there.
 */
export const PAGE_ROUTE_NEEDLE = 'path:`/codex-mobile`,';
export const PAGE_ROUTE_RE = rx(String.raw`,\(0,@jsx@\.jsx\)\((?<Route>${ID}(?:\.${ID})?),\{path:\`/codex-mobile\`,element:\(0,\k<jsx>\.jsx\)\(@el@,\{\}\)\}\)`);
export function derivePageRouteSeam(corpus) {
  const r = theOne(corpus, PAGE_ROUTE_NEEDLE, PAGE_ROUTE_RE, 'the route `/codex-mobile` in the app\'s route tree', { back: 60, forward: 80 });
  if (r.why) return { group: null, missing: [miss('seam:page-route', r.why)] };
  const { jsx, Route } = r.m.groups;
  const text = `${r.m[0]},(0,${jsx}.jsx)(${Route},{path:\`/codexmods/page/:mod/:page\`,element:(0,${jsx}.jsx)(globalThis.__codexmods?.PageRoute??(()=>null),{})})`;
  return { group: group('page-route', 'page-route', [{ id: 'seam-page-route', seam: 'page-route', file: r.file, op: 'replace-once', find: r.m[0], text,
    why: 'page-route seam: the framework\'s route for a mod\'s page in the app\'s route tree from module load, so its first navigation, a reload and history always find it' }]), missing: [] };
}

/**
 * The destinations of the rail and the sidebar's navigation (layouts.md D3, D7, WL5b; scout docs/research/layouts/wl5-pages.md §3): the app's
 * table is read by area only and the lists are built in the provider, so the mods' items go in there, before its split into pinned and more
 * (`let{primaryDestinations:L,standalonePrimaryDestinations:R,exploreDestinations:z}=Y_n(I,v===`disabled`,…`): every consumer sees them, the
 * user's pins and order included. The provider's head asks a hook, which renders it again when the mods' destinations change; where the list
 * sits in a compiler memo block (21477) the block's condition asks for that revision too.
 */
export const DESTINATIONS_NEEDLE = 'let{primaryDestinations:';
export const DESTINATIONS_RE = rx(String.raw`let\{primaryDestinations:@p@,standalonePrimaryDestinations:@s@,exploreDestinations:@x@\}=(?:@fn@|\(0,@fnns@\.@fnm@\))\(@list@,(?:@v@===\`disabled\`|\`disabled\`===@v2@),`);
const DESTINATIONS_HEAD_RE = rx(String.raw`\{children:@n@,desktopNavItemsEnabled:@r@\}=@e@,`);
const DESTINATIONS_NAV_RE = rx(String.raw`@nav@\(\`/projects\`,\{state:@st@\}\)\},isCurrentDestination:@loc@\.pathname\.startsWith\(\`/projects\`\)`);
const DESTINATIONS_MEMO_RE = rx(String.raw`;if\(@cache@\[\d+\]!==[\w$]+\|\|`);
export function deriveDestinationsSeam(corpus) {
  const r = theOne(corpus, DESTINATIONS_NEEDLE, DESTINATIONS_RE, 'the destinations\' split `let{primaryDestinations:L,…}=Y_n(I,v===`disabled`,…`', { back: 0, forward: 200 });
  const no = (why) => ({ group: null, missing: [miss('seam:destinations', why)] });
  if (r.why) return no(r.why);
  // the provider's head is up to a few tens of kB before the split (rspack 25679: 21 kB, the nav items built in an inlined function between them)
  const before = r.text.slice(Math.max(0, r.m.index - 40000), r.m.index);
  const head = matches(before, DESTINATIONS_HEAD_RE).at(-1);
  if (!head) return no(`the provider's head before the split in ${r.file}`);
  // all of it in the provider's own body: the head, the navigate and location, and the split are in one function (functions inlined between them, closed
  // before the split, are fine: their names are not the provider's)
  const body = before.slice(head.index);
  const bodyAt = r.m.index - before.length + head.index;
  const provider = enclosingFn(r.text, r.m.index, { innermost: true });
  if (!provider || provider.start > bodyAt) return no(`the provider's head and the split are not in one function in ${r.file}`);
  const nav = matches(body, DESTINATIONS_NAV_RE).at(-1);
  if (!nav) return no(`the provider's navigate and location before the split in ${r.file}`);
  const navFn = enclosingFn(r.text, bodyAt + nav.index, { innermost: true });
  if (!navFn || navFn.start !== provider.start) return no(`the provider's navigate and location are not in the provider's own body in ${r.file}`);
  if (occurrences(r.text, head[0]) !== 1) return no(`\`${head[0]}\` occurs ${occurrences(r.text, head[0])} times in ${r.file}, expected exactly 1`);
  // a compiler memo block around the list: the block whose else branch gives the list back from its cache, not another before it
  const list = r.m.groups.list;
  // by its braces: the block that holds the split, its `else` giving the list back, whichever others the compiler nests before it
  const memo = matches(body, DESTINATIONS_MEMO_RE).filter((x) => {
    const start = bodyAt + x.index;
    const open = r.text.indexOf('{', r.text.indexOf('){', start) + 1);
    const close = open < 0 ? -1 : matchClose(r.text, open);
    return close > r.m.index && r.text.startsWith(`else ${list}=${x.groups.cache}[`, close + 1);
  }).at(-1);
  const cache = memo?.groups.cache;
  const rev = 'globalThis.__codexmods?.destinationsRev?.()';
  const drafts = [
    { id: 'seam-destinations:head', seam: 'destinations', file: r.file, op: 'replace-once', find: head[0], text: `${head[0]}__cmDest=globalThis.__codexmods?.useDestinationsRev?.(),`,
      why: 'destinations seam: the provider renders again when the mods\' destinations change' },
    { id: 'seam-destinations', seam: 'destinations', file: r.file, op: 'replace-once', find: r.m[0],
      text: `${cache ? `${cache}.__cmDestRev=${rev};` : ''}${r.m.groups.list}=globalThis.__codexmods?.destinations?.(${r.m.groups.list},{location:${nav.groups.loc},navigate:${nav.groups.nav}})??${r.m.groups.list};${r.m[0]}`,
      why: 'destinations seam: the mods\' items in the app\'s list before its split, so its pins, order and every consumer see them' },
  ];
  if (memo) {
    if (occurrences(r.text, memo[0]) !== 1) return no(`\`${memo[0]}\` occurs ${occurrences(r.text, memo[0])} times in ${r.file}, expected exactly 1`);
    drafts.push({ id: 'seam-destinations:memo', seam: 'destinations', file: r.file, op: 'replace-once', find: memo[0], text: `;if(${cache}.__cmDestRev!==${rev}||${memo[0].slice(4)}`,
      why: 'destinations seam: the compiler\'s memo block around the list follows the mods\' destinations' });
  }
  return { group: group('destinations', 'destinations', drafts), missing: [] };
}

/**
 * The rail's mode (layouts.md D7, D10, WL5c; scout §4.2): a path the app does not know gets the rail alone. A mod's page with a sidebar view
 * asks for the app's contextual column at the end of the function that decides (22943 ``||D0r(e)==null&&C4r(r)?`rail-with-contextual-sidebar`:
 * `rail-only`}``); the earlier returns stay the app's, so this never turns the rail on.
 */
export const RAIL_MODE_NEEDLE = '?`rail-with-contextual-sidebar`:`rail-only`}';
export const RAIL_MODE_RE = rx(String.raw`\|\|(?:@d@\(@e@\)==null&&@c@\(@r@\)|null==\(0,@dn@\.@dm@\)\(@e2@\)&&(?<grp>\((?:[^()]|\([^()]*\))*\)))\?\`rail-with-contextual-sidebar\`:\`rail-only\`\}`);
export function deriveRailModeSeam(corpus) {
  const r = theOne(corpus, RAIL_MODE_NEEDLE, RAIL_MODE_RE, 'the rail\'s mode `||D(e)==null&&C(r)?`rail-with-contextual-sidebar`:`rail-only`}`', { back: 1200, forward: 0 });
  if (r.why) return { group: null, missing: [miss('seam:rail-mode', r.why)] };
  // the hook's test goes at the end of the condition, before its `?`: after the app's own (rolldown: `||D(e)==null&&C(r)`; rspack: `||null==(0,X.gw)(e)&&(…)`)
  const e = r.m.groups.e ?? r.m.groups.e2; const k = r.m[0].search(/\?[`"']rail-with-contextual-sidebar/);
  return { group: group('rail-mode', 'rail-mode', [{ id: 'seam-rail-mode', seam: 'rail-mode', file: r.file, op: 'replace-once', find: r.m[0],
    text: `${r.m[0].slice(0, k)}||globalThis.__codexmods?.railMode?.(${e})===!0${r.m[0].slice(k)}`,
    why: 'rail-mode seam: a mod\'s page with a sidebar view gets the app\'s contextual column where the rail shows' }]), missing: [] };
}

/**
 * The app's copy helper (F3; scout F3-copy-redaction): `async function F(content,event,onSuccess){content instanceof Promise&&…;let{navigator,
 * document}=event?.target?.ownerDocument?.defaultView??window` (21477 app-shared `tTn`, 20770 `lCn`): the app's copy buttons and menus (a
 * message's, a plan's, a command's, "Copy as Markdown") give it what they copy, then it writes the clipboard (a string through main, rich
 * content in the page).
 */
export const COPY_RE = rx(String.raw`async function @name@\(@e@,@t@,@n@\)\{(?:let [\w$,]+;)?\k<e> instanceof Promise&&\k<e>\.catch\([^;]{0,160}\);let\{navigator:@r@,document:@i@\}=\k<t>\?\.target\?\.ownerDocument\?\.defaultView\?\?window`);
export const COPY_NEEDLE = '?.target?.ownerDocument?.defaultView??window';
export function deriveCopySeam(corpus) {
  const r = theOne(corpus, COPY_NEEDLE, COPY_RE, 'copy helper `async function F(e,t,n){e instanceof Promise&&e.catch(()=>{});let{navigator:r,document:i}=t?.target?.ownerDocument?.defaultView??window`', { back: 120, forward: 0 });
  if (r.why) return { group: null, missing: [miss('seam:copy', r.why)] };
  const { name, e, t, n } = r.m.groups;
  // the helper keeps its name for its callers: a wrapper under that name gives the hook what is copied (with where it is from, a fourth
  // argument the thread actions give it: seam copy-origin) and copies what it answers
  const body = (orig) => `var __cmH=globalThis.__codexmods?.copy;if(typeof __cmH=="function"){try{var __cmO=__cmH(__cmA,__cmE,__cmS);if(__cmO!=null)__cmA=__cmO}`
    + `catch(__cmX){var __cmF=globalThis.__codexmods?.faults;__cmF&&(__cmF.copy=(__cmF.copy|0)+1)}}return ${orig}(__cmA,__cmE,__cmN)`;
  const rest = `${e},${t},${n}){`;
  const w = wrapFunction(r.text, { kw: 'async ', name, rest, more: r.m[0].slice(`async function ${name}(${rest}`.length), params: '__cmA,__cmE,__cmN,__cmS', body });
  if (w.why) return { group: null, missing: [miss('seam:copy', `${w.why} in ${r.file}`)] };
  // rspack: the module that holds the helper, for the origins' check (a call there is `(0,X.E)(…)`, X bound to that module, E its export of the helper)
  return { group: group('copy', 'copy', wrapDrafts(w, 'seam-copy', 'copy', r.file,
    'copy seam: what the app\'s copy helper is given passes globalThis.__codexmods.copy(content, event, origin) first; what it answers is copied, null or a throw copies the content as it was')), missing: [], helper: { file: r.file, name, module: r.module?.id ?? null } };
}

/**
 * Where a thread action's copy is from (F3, the built review's round 2): "Copy as Markdown" (21477 app-initial `ubo`, 20770 `d0o`: it
 * loads the chat and builds its Markdown, then copies it), "Copy working directory" (`sbo`, `c0o`: it may read the chat's worktree first)
 * and the chat's app link (the thread actions' `copyAppLink`, a promise of it). The menus, the palette and the keys run these same
 * actions. Each call to the copy helper is given a fourth argument, where its content is from: `{chat:<the chat's id>}`, or `{content:!1}`
 * (not a chat's content); the helper's wrapper hands it to the hook with what is copied, so a copy that awaits first is known by its own
 * call (never by the next copy). Data only: the edit inserts `,void 0,void 0,{...}` before the call's `)`, the helper's own arguments
 * as the app gives them (none).
 */
/** The copy helper as a call site names it: a name (rolldown) or a member of a required module, `(0,X.E)` (rspack). */
const CALLEE = `(?:${ID}|\\(0,${ID}\\.${ID}\\))`;
export const ORIGIN_SITES = Object.freeze([
  { id: 'markdown', needle: ',getMarkdown:', window: { back: 160, forward: 420 },
    what: '"Copy as Markdown" `function F({scope,conversationId,parentConversationId,getMarkdown,intl}){(async()=>{...;let a=await getMarkdown();...&&await copy(a)`',
    re: rx(String.raw`function(?: @name@)?\(\{scope:@s@,conversationId:@c@,parentConversationId:@p@,getMarkdown:@g@,intl:@i@\}\)\{\(async\(\)=>\{[^;]{0,240};let @a@=await \k<g>\(\);(?:\k<a>!=null&&\k<a>\.trim\(\)\.length!==0&&|null==\k<a>\|\|0===\k<a>\.trim\(\)\.length\|\|)await (?<h>${CALLEE})\(\k<a>\)`),
    edit: (g, m0) => [m0.slice(m0.lastIndexOf(`let ${g.a}=await `), -1), ')', `{chat:${g.c}}`] },
  { id: 'folder', needle: '.copyWorkingDirectorySuccess))', window: { back: 460, forward: 0 },
    what: '"Copy working directory" `function F({scope,cwd,thread,intl}){(async()=>{let i=cwd;...,i&&await copy(i)&&scope.get(..).success(..copyWorkingDirectorySuccess))`',
    re: rx(String.raw`function(?: @name@)?\(\{scope:@s@,cwd:@c@,thread:@t@,intl:@r@\}\)\{\(async\(\)=>\{let @i@=\k<c>;[^;]{0,320}?,\k<i>&&await (?<h>${CALLEE})\(\k<i>\)&&\k<s>\.get\((?<n>${ID}(?:\.${ID})?)\)\.success\(\k<r>\.formatMessage\(@m@\.copyWorkingDirectorySuccess\)\)`),
    edit: (g) => [`${g.i}&&await ${g.h}(${g.i}`, `)&&${g.s}.get(${g.n}).success(${g.r}.formatMessage(${g.m}.copyWorkingDirectorySuccess))`, '{content:!1}'] },
  { id: 'link', needle: '.getFollowUpContext(', window: { back: 80, forward: 240 },
    what: 'the app link `if(e==null)return;let i=t??`local`;copy(api(n,i).getFollowUpContext(...)...)}`',
    re: rx(String.raw`if\((?:@e@==null|null==@e2@)\)return;let @i@=@t@\?\?(?<dflt>[^;,]{1,24});(?<h>${CALLEE})\((?<expr>(?:@x@|\(0,@xn@\.@xm@\))\(@n@,\k<i>\)\.getFollowUpContext\([^;{}]*?)\)\}`),
    edit: (g) => [`let ${g.i}=${g.t}??${g.dflt};${g.h}(${g.expr}`, ')}', '{content:!1}'] },
]);
/** The thread actions' copy origins (ORIGIN_SITES), each call's helper checked to be the copy seam's (`helper`: {file, name}). */
export function deriveCopyOrigins(corpus, helper) {
  if (!helper) return { group: null, missing: [] };   // no copy seam: nothing would hand an origin on
  const drafts = []; const missing = [];
  const exported = new RegExp(`(?<![\\w$])${esc(helper.name)} as (${ID})(?=[,}])`).exec(corpus.text(helper.file))?.[1] ?? null;
  const stem = helper.file.split('/').pop();
  // rspack: the helper's module exports it under a key, `n.d(t,{},{E:c,…})`; a call site names it `(0,X.E)`, X the module required from its own module
  let key = null;
  if (helper.module) {
    const htext = corpus.text(helper.file); const hmod = corpus.modules(helper.file)?.find((m) => m.id === helper.module);
    const mbody = hmod ? htext.slice(hmod.open, hmod.close) : '';
    const dm = /\.d\(\w+,(?:\{\},)?\{/.exec(mbody);
    const obj = dm ? mbody.slice(dm.index + dm[0].length - 1, matchClose(mbody, dm.index + dm[0].length - 1) + 1) : '';
    const ks = [...obj.matchAll(new RegExp(`[{,]([\\w$]+):${esc(helper.name)}(?=[,}])`, 'g'))];
    key = ks.length === 1 ? ks[0][1] : null;
  }
  for (const site of ORIGIN_SITES) {
    const item = `seam:copy-origin:${site.id}`;
    const r = theOne(corpus, site.needle, site.re, site.what, site.window);
    if (r.why) { missing.push(miss(item, r.why)); continue; }
    const g = r.m.groups;
    // the call is the copy helper's: the helper itself in its own chunk, else its export imported under that name
    let imported;
    if (helper.module) {
      const via = /^\(0,([\w$]+)\.([\w$]+)\)$/.exec(g.h); const req = r.module?.params.split(',')[2];
      imported = via !== null && key !== null && via[2] === key && !!req
        && new RegExp(`(?<![\\w$.])${esc(via[1])}=${esc(req)}\\("${esc(helper.module)}"\\)`).test(r.text.slice(r.module.open, r.module.close));
    } else {
      imported = r.file === helper.file ? g.h === helper.name
        : exported !== null && new RegExp(`import\\{[^}]*(?<![\\w$])${esc(exported)} as ${esc(g.h)}(?=[,}])[^}]*\\}from"\\./${esc(stem)}"`).test(r.text);
    }
    if (!imported) { missing.push(miss(item, `${g.h} in ${r.file} is not the copy helper ${helper.name} of ${helper.file}`)); continue; }
    const [before, after, origin] = site.edit(g, r.m[0]);
    const find = before + after;
    if (occurrences(r.text, find) !== 1) { missing.push(miss(item, `\`${find.slice(0, 80)}\` occurs ${occurrences(r.text, find)} times in ${r.file}, expected exactly 1`)); continue; }
    drafts.push({ id: `seam-copy-origin:${site.id}`, seam: 'copy-origin', file: r.file, op: 'replace-once', find, text: `${before},void 0,void 0,${origin}${after}`,
      why: `copy origin: the thread action's copy (${site.id}) tells the copy helper where its content is from (${origin})` });
  }
  return { group: drafts.length ? group('copy-origin', 'copy-origin', drafts) : null, missing };
}

/**
 * The app's command dispatcher (H6m3; scout H6m-chat-holds §4): `function F(id,keyboardEvent,source,origin){let i=stack.get(id);for(let e
 * of[`normal`,`fallback`])` (21477 app-initial `ACr`, 20770 `ibr`): every command the page runs (the palette's, a key chord the page sees,
 * the app's buttons, a native menu's `run-command`) goes through it, its answer whether one handled it.
 */
export const COMMAND_RE = rx(String.raw`function @name@\(@e@,@t@,@n@,@r@\)\{let @i@=@stack@\.get\(\k<e>\);for\(let @x@ of\[\`normal\`,\`fallback\`\]\)`);
export const COMMAND_NEEDLE = 'of[`normal`,`fallback`])';
export function deriveCommandSeam(corpus) {
  const r = theOne(corpus, COMMAND_NEEDLE, COMMAND_RE, 'command dispatcher `function F(e,t,n,r){let i=stack.get(e);for(let e of[`normal`,`fallback`])`', { back: 120, forward: 0 });
  if (r.why) return { group: null, missing: [miss('seam:command', r.why)] };
  const { name, e, t, n, r: o } = r.m.groups;
  // the dispatcher keeps its name for its callers: a wrapper under that name asks the hook first, with the run as the app does it (an
  // event given replaces the one it had: a held key chord's, already handled); a boolean answered is the dispatch's answer (the hook ran
  // it, or holds it); anything else, or a throw before it ran, is the app's own dispatch; once it ran it never runs again (built review
  // H6m3a: a command that throws is not run twice), its throw is the dispatcher's
  const body = (orig) => `var __cmH=globalThis.__codexmods?.command;if(typeof __cmH=="function"){var __cmR=0,__cmV;try{var __cmO=__cmH(__cmA,__cmB,__cmC,__cmD,function(__cmE){__cmR=1;return __cmV=${orig}(__cmA,__cmE===void 0?__cmB:__cmE,__cmC,__cmD)});if(typeof __cmO=="boolean")return __cmO}`
    + `catch(__cmX){if(__cmR)throw __cmX;var __cmF=globalThis.__codexmods?.faults;__cmF&&(__cmF.command=(__cmF.command|0)+1)}if(__cmR)return __cmV}return ${orig}(__cmA,__cmB,__cmC,__cmD)`;
  const rest = `${e},${t},${n},${o}){`;
  const w = wrapFunction(r.text, { name, rest, more: r.m[0].slice(`function ${name}(${rest}`.length), params: '__cmA,__cmB,__cmC,__cmD', body });
  if (w.why) return { group: null, missing: [miss('seam:command', `${w.why} in ${r.file}`)] };
  return { group: group('command', 'command', wrapDrafts(w, 'seam-command', 'command', r.file,
    'command seam: the page\'s command dispatcher asks globalThis.__codexmods.command(id, keyboardEvent, source, origin, run) first; a boolean answered is its answer, anything else or a throw the app\'s own dispatch')), missing: [] };
}

/**
 * The composer's attach factory (H6m3b): `function F({scope,attachmentGeneration,canceledPendingFileAttachmentIds,...})` (21477
 * app-initial `REd`, 20770 `Xhd`) makes a composer's attach methods (addFiles, addPickedFiles, addImages, addDraggedImage, ...) as an
 * attach happens: the picker's, a paste's, a drop's. It keeps its name for its callers under a wrapper that gives the hook the methods it
 * made, with its arguments; an object answered is used in their place, anything else or a throw the app's own.
 */
export const ATTACH_RE = rx(String.raw`function(?: @name@)?\(\{scope:@e@,attachmentGeneration:@t@,canceledPendingFileAttachmentIds:@n@,`);
export const ATTACH_NEEDLE = ',canceledPendingFileAttachmentIds:';
export function deriveAttachSeam(corpus) {
  const r = theOne(corpus, ATTACH_NEEDLE, ATTACH_RE, 'attach factory `function F({scope,attachmentGeneration,canceledPendingFileAttachmentIds,...})`', { back: 120, forward: 16 });
  if (r.why) return { group: null, missing: [miss('seam:attach', r.why)] };
  const { name, e, t, n } = r.m.groups;
  // the factory keeps its name for its callers: a wrapper under that name gives the hook the methods it made; an object answered is used
  const body = (orig) => `var __cmM=${orig}(__cmA),__cmH=globalThis.__codexmods?.attach;if(typeof __cmH=="function"&&__cmM&&typeof __cmM=="object"){try{var __cmO=__cmH(__cmM,__cmA);if(__cmO&&typeof __cmO=="object")return __cmO}`
    + `catch(__cmX){var __cmF=globalThis.__codexmods?.faults;__cmF&&(__cmF.attach=(__cmF.attach|0)+1)}}return __cmM`;
  const w = wrapFunction(r.text, { at: r.m.index, name: name ?? null, rest: `{scope:${e},attachmentGeneration:${t},`, restExpr: `{scope:${e},attachmentGeneration:${t},canceledPendingFileAttachmentIds:${n},`, body });
  if (w.why) return { group: null, missing: [miss('seam:attach', `${w.why} in ${r.file}`)] };
  return { group: group('attach', 'attach', wrapDrafts(w, 'seam-attach', 'attach', r.file,
    'attach seam: the composer\'s attach methods pass globalThis.__codexmods.attach(methods, args) as they are made; an object answered is used in their place, anything else or a throw the app\'s own')), missing: [] };
}

/**
 * The review panel's git actions (H6m4): `async function F({scope,cwd,diffText,hostConfig,params,reviewFiles,refreshPathsFast,...})`
 * (21477 thread-side-panel-tab-content `Ms`, 20770 `Qo`): a file's, a part of one's or a section's stage, unstage or revert as the user
 * asks it (`params: {scope, action, path, hunkIndex}`; a section's files). It keeps its name under a wrapper that asks the hook first with
 * its argument and its own run: anything but undefined answered is its answer (awaited: the hook ran it, or holds it); undefined, or a
 * throw before it ran, the app's own; once it ran it never runs again, its throw its own.
 */
export const REVIEW_ACTION_RE = rx(String.raw`async function(?: @name@)?\(\{scope:@e@,cwd:@t@,diffText:@n@,hostConfig:@r@,params:@i@,reviewFiles:@a@,`);
export const REVIEW_ACTION_NEEDLE = ',reviewFiles:';
export function deriveReviewActionSeam(corpus) {
  const r = theOne(corpus, REVIEW_ACTION_NEEDLE, REVIEW_ACTION_RE, 'review panel action `async function F({scope,cwd,diffText,hostConfig,params,reviewFiles,...})`', { back: 120, forward: 8 });
  if (r.why) return { group: null, missing: [miss('seam:review-action', r.why)] };
  const { name, e, t, n, r: h, i, a } = r.m.groups;
  const body = (orig) => `var __cmH=globalThis.__codexmods?.reviewAction;if(typeof __cmH=="function"){var __cmR=0;try{var __cmO=__cmH(__cmA,function(){__cmR=1;return ${orig}(__cmA)});if(__cmO!==void 0)return await __cmO}`
    + `catch(__cmX){if(__cmR)throw __cmX;var __cmF=globalThis.__codexmods?.faults;__cmF&&(__cmF.reviewAction=(__cmF.reviewAction|0)+1)}if(__cmR)return}return ${orig}(__cmA)`;
  const w = wrapFunction(r.text, { at: r.m.index + 'async '.length, kw: 'async ', name: name ?? null, rest: `{scope:${e},cwd:${t},diffText:${n},hostConfig:${h},params:${i},reviewFiles:${a},`, body });
  if (w.why) return { group: null, missing: [miss('seam:review-action', `${w.why} in ${r.file}`)] };
  return { group: group('review-action', 'review-action', wrapDrafts(w, 'seam-review-action', 'review-action', r.file,
    'review action seam: the review panel\'s git action asks globalThis.__codexmods.reviewAction(arg, run) first; anything but undefined answered is its answer, undefined or a throw before it ran the app\'s own')), missing: [] };
}

/**
 * A pull request the user creates (H6m4, built review round 1): the app's creation mutation picks its route after reading the project's
 * GitHub source (21477 and 20770 git-action-new-branch-field: `…,c=s?.status===`success`?s.account:null,l=t.query.snapshot(…).queryKey;
 * switch(n.signal?.throwIfAborted(),o){case`github-cli`:…case`github-connector`:…`). Right before the switch (both routes after it, every
 * name its answer uses defined) the hook is asked with what is created; a reason it answers is thrown (the page shows it), a pull request
 * a mod made in the app's place is the mutation's answer, as the app's own success is.
 */
export const PR_CREATE_RE = rx(String.raw`,@c@=@s@\?\.status===\`success\`\?\k<s>\.account:null,@l@=@t@\.query\.snapshot\(${ID}(?:\.${ID})?,\{cwd:@e@\.cwd,headBranch:@n@\.headBranch,hostId:\k<e>\.hostId,operationSource:\k<n>\.operationSource\}\)\.queryKey;switch\(\k<n>\.signal\?\.throwIfAborted\(\),@o@\)\{case\`github-cli\`:`);
export const PR_CREATE_NEEDLE = '){case`github-cli`:';
export function derivePullRequestCreateSeam(corpus) {
  const r = theOne(corpus, PR_CREATE_NEEDLE, PR_CREATE_RE, 'pull request creation `switch(n.signal?.throwIfAborted(),o){case`github-cli`:`', { back: 320, forward: 0 });
  if (r.why) return { group: null, missing: [miss('seam:pr-create', r.why)] };
  const { c, l, e, n, o } = r.m.groups;
  const find = r.m[0].slice(r.m[0].indexOf('switch('));   // the build's own quotes: a template literal (rolldown) or a string (rspack)
  if (occurrences(r.text, find) !== 1) return { group: null, missing: [miss('seam:pr-create', `\`${find}\` occurs ${occurrences(r.text, find)} times in ${r.file}, expected exactly 1`)] };
  const text = `{var __cmH=globalThis.__codexmods?.pullRequestCreate;if(typeof __cmH=="function"){var __cmO=await __cmH({cwd:${e}.cwd,hostId:${e}.hostId,headBranch:${n}.headBranch,baseBranch:${n}.baseBranch,`
    + `isDraft:${n}.isDraft,openInBrowser:${n}.openInBrowser,titleOverride:${n}.titleOverride,bodyOverride:${n}.bodyOverride,source:${o}});if(__cmO&&typeof __cmO.refused=="string")throw Error(__cmO.refused);`
    + `if(__cmO&&__cmO.handled&&typeof __cmO.handled.url=="string")return{number:__cmO.handled.number,url:__cmO.handled.url,account:${c},provider:${o},discoveryQueryKey:${l}}}}${find}`;
  return { group: group('pr-create', 'pr-create', [{ id: 'seam-pr-create', seam: 'pr-create', file: r.file, op: 'replace-once', find, text,
    why: 'pull request create seam: the creation asks globalThis.__codexmods.pullRequestCreate(arg) before either route runs' }]), missing: [] };
}

export function deriveMarkdownSeam(corpus) {
  const drafts = []; const missing = [];
  // each builder keeps its name for its callers: a wrapper under that name gives the hook the call's own options and the app's map
  const wrap = (key, needle, re, what, hook, opener) => {
    const r = theOne(corpus, needle, re, what, { back: 60, forward: 700 });
    if (r.why) { missing.push(miss(`seam:markdown:${key}`, r.why)); return; }
    const name = r.m.groups.name; const f = safeNames(name);
    const find = `function ${name}(${opener}`;
    if (occurrences(r.text, find) !== 1) { missing.push(miss(`seam:markdown:${key}`, `\`${find}\` occurs ${occurrences(r.text, find)} times in ${r.file}, expected exactly 1`)); return; }
    if (new RegExp(`(?<![\\w$])${esc(name)}__cm(?![\\w$])`).test(r.text)) { missing.push(miss(`seam:markdown:${key}`, `${name}__cm is already a name in ${r.file}`)); return; }
    const text = `function ${f}(__cmA){var __cmR=${f}__cm(__cmA),__cmH=globalThis.__codexmods?.${hook};if(typeof __cmH!="function"||!__cmR||typeof __cmR!="object")return __cmR;`
      + `try{var __cmO=__cmH(__cmA,__cmR);return __cmO&&typeof __cmO=="object"?__cmO:__cmR}catch(__cmX){var __cmF=globalThis.__codexmods?.faults;__cmF&&(__cmF.markdown=(__cmF.markdown|0)+1);return __cmR}}`
      + `function ${f}__cm(${opener}`;
    drafts.push({ id: `seam-markdown:${key}`, seam: 'markdown', file: r.file, op: 'replace-once', find, text, why: `markdown seam: the app's markdown ${key} (every markdown site's) pass globalThis.__codexmods.${hook}(options, ${key}); absent, throwing or not an object, the app's own` });
  };
  wrap('components', MD_COMPONENTS_NEEDLE, MD_COMPONENTS_RE, 'markdown components builder `function F({allowWideBlocks, conversationId, cwd, externalLinkAppearance, …}){return{a:…}}`', 'markdownComponents', '{allowWideBlocks:');
  wrap('directives', MD_DIRECTIVES_NEEDLE, MD_DIRECTIVES_RE, 'markdown directives builder `function F({conversationId, cwd, enableInlineDil, …}){return{…}}`', 'markdownDirectives', '{conversationId:');
  // both or neither: a mod's part renderers need the two
  if (missing.length) return { group: null, missing };
  return { group: group('markdown', 'markdown', drafts), missing: [] };
}

export function deriveAppHostSeam(source) {
  const main = findMainBundle(source, ['createAppHost(', 'registerAppView(']);
  if (main.error) return { group: null, missing: [miss('seam:app-host', main.error)] };
  // both spellings counted together: one of each is two registrations, and the seam would hold only one window's AppHost
  const ms = matches(main.text, APP_HOST_RE); const inline = matches(main.text, APP_HOST_INLINE_RE); const split = matches(main.text, APP_HOST_SPLIT_RE);
  if (ms.length + inline.length + split.length !== 1) return { group: null, missing: [miss('seam:app-host', `AppHost creation and AppView registration: ${ms.length + inline.length + split.length} matches in ${main.file}, expected exactly 1`)] };
  const why = 'AppHost hold: globalThis.__codexmods.appHost(host, sender, view) is told about each window\'s AppHost and AppView after the AppView is registered';
  const call = (host, ev, view) => `try{globalThis.__codexmods?.appHost?.(${host},${ev}.sender,${view})}catch(__cmX){let __cmF=globalThis.__codexmods?.faults;__cmF&&(__cmF.appHost=(__cmF.appHost|0)+1)}`;
  if (ms.length) {
    const m = ms[0]; const end = chainEnd(main.text, m.index + m[0].length);
    if (end < 0 || !/^[;}]/.test(main.text.slice(end, end + 1))) return { group: null, missing: [miss('seam:app-host', `the registerAppView statement in ${main.file} does not end the statement`)] };
    const find = main.text.slice(m.index + m[0].indexOf(`${m.groups.ctx}?.registerAppView(`), end);
    return { group: group('app-host', 'app-host', [{ id: 'seam-app-host', seam: 'app-host', file: main.file, op: 'insert-after-once', find, text: `;${call(m.groups.host, m.groups.ev, m.groups.view)}`, why }]), missing: [] };
  }
  if (split.length) {
    // the host and the view have bindings of their own: the hook is called after the registration statement, as in the first shape
    const m = split[0]; const end = chainEnd(main.text, m.index + m[0].length);
    if (end < 0 || !/^[;}]/.test(main.text.slice(end, end + 1))) return { group: null, missing: [miss('seam:app-host', `the registerAppView statement in ${main.file} does not end the statement`)] };
    const find = main.text.slice(m.index + m[0].lastIndexOf(`null!=${m.groups.ctx}&&${m.groups.ctx}.registerAppView(`), end);
    return { group: group('app-host', 'app-host', [{ id: 'seam-app-host', seam: 'app-host', file: main.file, op: 'insert-after-once', find, text: `;${call(m.groups.host, m.groups.ev, m.groups.view)}`, why }]), missing: [] };
  }
  // the host has no binding of its own here: one is added to the declaration list the AppView's own binding is in (`let[t]=e.ports,r=d(e.sender),n=…`)
  const m = inline[0]; const g = m.groups; const end = chainEnd(main.text, m.index + m[0].length);
  if (end < 0 || !/^[;}]/.test(main.text.slice(end, end + 1))) return { group: null, missing: [miss('seam:app-host', `the registerAppView statement in ${main.file} does not end the statement`)] };
  const stmt = main.text.slice(Math.max(0, m.index - 240), m.index);
  if (!/(?:^|[;{}])\s*(?:let|const|var)[\s[{][^;{}]*,$/.test(stmt.slice(Math.max(stmt.lastIndexOf(';'), stmt.lastIndexOf('{'), stmt.lastIndexOf('}')) + 1))) return { group: null, missing: [miss('seam:app-host', `the AppView's binding in ${main.file} is not in a declaration list, so a host binding cannot be added beside it`)] };
  if (new RegExp(`(?<![\\w$])__cmH(?![\\w$])`).test(main.text)) return { group: null, missing: [miss('seam:app-host', `__cmH is already a name in ${main.file}`)] };
  const find = main.text.slice(m.index, end);
  const rest = find.slice(find.indexOf(`null!=${g.ctx}&&`));
  const text = `__cmH=${g.ctx}?.createAppHost(${g.ev}.sender),${g.view}=${g.make}(${g.port},__cmH);${rest};${call('__cmH', g.ev, g.view)}`;
  return { group: group('app-host', 'app-host', [{ id: 'seam-app-host', seam: 'app-host', file: main.file, op: 'replace-once', find, text, why }]), missing: [] };
}

/**
 * The app's main-process modules on a webpack build (22943 re-bundled main as webpack chunks, so its modules are not Node's: framework-main
 * reads tables such as the command table from the loaded modules' exports). The runtime of the entry chunk (`r.m=a,r.c=i,`: its factories
 * and its module cache) hands framework-main the cache as data, `globalThis.__codexmods.mainModules` (`{ id: { exports } }`, the shape of
 * Node's `require.cache` entries). A build without a webpack runtime in main needs none: no group and nothing missing.
 */
export const MAIN_MODULES_RE = rx(String.raw`(?<![\w$.])(?:@r@\.m=@f@,\k<r>\.c=@c@|@r2@\.c=@c2@,\k<r2>\.m=@f2@),`);
/** The webpack runtime's chunk loader in main: `require("./"+r.u(e))` in any quote style, or `require(\`./${r.u(e)}\`)`; the name is the runtime's. */
const LOADER_RE = /require\((?:(["'`])\.\/\1\+([\w$]+)\.u\(|`\.\/\$\{([\w$]+)\.u\()/g;
export function deriveMainModulesSeam(source) {
  // a webpack main is known by its chunk loader or by its module cache (either one drifting is a missing seam, not a build without one);
  // the one runtime that loads main's chunks must have its module cache, in one place
  const runtimes = source.list('.vite/build/').filter(isMainBundle).map((file) => ({ file, text: source.read(file) }))
    .map((c) => ({ ...c, loaders: [...new Set(matches(c.text, LOADER_RE).map((m) => m[2] ?? m[3]))], caches: matches(c.text, MAIN_MODULES_RE) }))
    .filter((c) => c.loaders.length || c.caches.length);
  if (!runtimes.length) return { group: null, missing: [] };   // not a webpack main: Node's require.cache has its modules
  const hits = runtimes.map((c) => ({ ...c, ms: c.caches.filter((m) => c.loaders.includes(m.groups.r ?? m.groups.r2)) })).filter((c) => c.ms.length);
  if (hits.length !== 1 || hits[0].ms.length !== 1) return { group: null, missing: [miss('seam:main-modules', `a webpack runtime is in main (${runtimes.map((c) => c.file).join(', ')}), but the module cache (\`r.m=…,r.c=…,\`) of the one that loads main's chunks: ${hits.reduce((n, h) => n + h.ms.length, 0)} matches in ${hits.length} files, expected exactly 1`)] };
  const { file, text: t, ms: [m] } = hits[0];
  const find = m[0];
  if (occurrences(t, find) !== 1) return { group: null, missing: [miss('seam:main-modules', `the runtime's text occurs ${occurrences(t, find)} times in ${file}`)] };
  const text = `${find}(__cmN=>{__cmN&&"object"==typeof __cmN&&(__cmN.mainModules=${m.groups.c ?? m.groups.c2})})(globalThis.__codexmods),`;
  return { group: group('main-modules', 'main-modules', [{ id: 'seam-main-modules', seam: 'main-modules', file, op: 'replace-once', find, text,
    why: "main's modules: the webpack runtime hands framework-main its module cache (globalThis.__codexmods.mainModules) so tables in the app's main-process modules can be read" }]), missing: [] };
}

/**
 * The menu bar items' commands (H6m3b, built review round 1): main's builder of a command's menu item (`N=(e,t)=>{let n=…({commandId:e});
 * if(n==null)throw Error(`Electron menu command '${e}' is not defined`);…;return{label:…,accelerator:…,visible:…}}`, 21477 and 20770) gives
 * each item its command's id as a data field, `codexmodsCommand` (Electron keeps a template's other fields on its MenuItem), so a click
 * on it is the user's run of that command whatever language its label is in. Data only: `codexmodsCommand:<the id's name>,` after `{`.
 */
export const MENU_COMMAND_RE = rx(String.raw`throw Error\(\`Electron menu command '\$\{@e@\}' is not defined\`\);let @r@=[^;{}]{0,80};return\{label:`);
export function deriveMenuCommandSeam(source) {
  const main = findMainBundle(source, ['createAppHost(', 'registerAppView(']);
  if (main.error) return { group: null, missing: [miss('seam:menu-command', main.error)] };
  const ms = matches(main.text, MENU_COMMAND_RE);
  if (ms.length !== 1) return { group: null, missing: [miss('seam:menu-command', `a command's menu item builder: ${ms.length} matches in ${main.file}, expected exactly 1`)] };
  const find = ms[0][0];
  if (occurrences(main.text, find) !== 1) return { group: null, missing: [miss('seam:menu-command', `the builder's text occurs ${occurrences(main.text, find)} times in ${main.file}`)] };
  const text = find.replace(/return\{label:$/, `return{codexmodsCommand:${ms[0].groups.e},label:`);
  return { group: group('menu-command', 'menu-command', [{ id: 'seam-menu-command', seam: 'menu-command', file: main.file, op: 'replace-once', find, text,
    why: 'menu command: each command\'s menu item carries its command id (codexmodsCommand), data only' }]), missing: [] };
}

/**
 * The exposures: every key located once, grouped per chunk into one insertion before the chunk's source-map comment.
 * @returns {{ groups: object[], exposures: {key, file, role}[], missing: object[] }}
 */
export function deriveExposures(corpus) {
  const byFile = new Map(); const exposures = []; const missing = [];
  const insts = new Map();
  for (const def of EXPOSURES) {
    const found = [];
    for (const { file } of corpus.find(def.needle)) {
      const text = corpus.text(file);
      if (!insts.has(file)) insts.set(file, new Inits(text));
      let hits;
      try { hits = def.locate(text, { inits: insts.get(file), file, corpus }); } catch (e) { missing.push(miss(`expose:${def.key}`, `locator failed in ${file}: ${String(e.message).split('\n')[0]}`)); hits = null; }
      if (hits) for (const h of hits) found.push({ file, ...h });
    }
    // rspack: one module is one site, wherever copies of it are (one match in each); each copy gets the block
    const sites = new Map();
    for (const f of found) { f.module = corpus.moduleAt?.(f.file, f.index ?? 0) ?? null; const k = f.module ? `module:${f.module.id}` : `${f.file}@${f.index}`; if (!sites.has(k)) sites.set(k, []); sites.get(k).push(f); }
    const copies = sites.size === 1 ? [...sites.values()][0] : [];
    if (sites.size !== 1 || new Set(copies.map((c) => c.file)).size !== copies.length) {
      if (!missing.some((m) => m.item === `expose:${def.key}`)) missing.push(miss(`expose:${def.key}`, `${found.length} matches${sites.size !== found.length ? ` (${sites.size} modules)` : ''} in ${new Set(corpus.find(def.needle).map((f) => role(f.file))).size} renderer chunk(s) holding ${JSON.stringify(def.needle)}, expected exactly 1`));
      continue;
    }
    for (const f of copies) {
      const at = f.module ? `${f.file}\0${f.module.id}` : f.file;
      if (!byFile.has(at)) byFile.set(at, []);
      byFile.get(at).push([def.key, f.expr]);
    }
    exposures.push({ key: def.key, file: copies[0].file, role: role(copies[0].file), ...(copies[0].module ? { module: copies[0].module.id, copies: copies.length } : {}) });
  }
  const groups = []; const used = new Set();
  for (const [at, entries] of [...byFile].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (at.includes('\0')) {
      // an rspack module: the block goes first in its body, anchored on the module's head (unique in its chunk)
      const [file, id] = at.split('\0');
      const text = corpus.text(file); const mod = corpus.modules(file).find((m) => m.id === id); const find = moduleHead(text, mod);
      if (occurrences(text, find) !== 1) { for (const [k] of entries) missing.push(miss(`expose:${k}`, `${file}: the head of module ${id} occurs ${occurrences(text, find)} times`)); for (const e of exposures.filter((x) => entries.some(([k]) => k === x.key))) e.dropped = true; continue; }
      const gid = `seam-expose:${role(file)}:${id}`;
      used.add(gid);
      groups.push(group(gid, 'expose', [{ id: gid, seam: 'expose', file, op: 'insert-after-once', find, text: moduleExposureText(entries), why: `exposures: ${entries.map(([k]) => k).join(', ')} named under globalThis.__codexmods.exports (lazy getters, no change of behaviour)` }], { keys: entries.map(([k]) => k) }));
      continue;
    }
    const file = at;
    const text = corpus.text(file);
    const comments = text.match(SOURCEMAP_RE) ?? [];
    if (comments.length !== 1) { for (const [k] of entries) { missing.push(miss(`expose:${k}`, `${file}: expected exactly one sourceMappingURL comment, found ${comments.length}`)); } for (const e of exposures.filter((x) => x.file === file)) e.dropped = true; continue; }
    let id = `seam-expose:${role(file)}`; for (let n = 2; used.has(id); n++) id = `seam-expose:${role(file)}:${n}`;
    used.add(id);
    groups.push(group(id, 'expose', [{ id, seam: 'expose', file, op: 'insert-before-once', find: comments[0], text: exposureText(entries), why: `exposures: ${entries.map(([k]) => k).join(', ')} named under globalThis.__codexmods.exports (lazy getters, no change of behaviour)` }], { keys: entries.map(([k]) => k) }));
  }
  return { groups, exposures: exposures.filter((e) => !e.dropped), missing };
}

/** A corpus of the renderer chunks of `source` (memoised by the caller; one pass over every chunk). */
export const corpusOf = (source) => new Corpus(source, NEEDLES);

/**
 * All UI seams of a build, as atomic groups.
 * @returns {{ groups: {id, seam, drafts, keys?}[], drafts: object[], missing: object[], exposures: object[] }}
 *   `drafts` are the drafts of the groups that derived, in apply order (jsx, lazy, taps, menus, app-host, exposures); `missing` lists what did not derive.
 */
export function deriveUiSeams(source, { corpus = corpusOf(source) } = {}) {
  const missing = []; const groups = [];
  const each = (derive) => eachCopy(corpus, () => derive(corpus));
  const copy = each(deriveCopySeam);
  for (const r of [each(deriveJsxSeam), each(deriveLazySeam), each(deriveTapSeams), each(deriveMenuSeam), each(deriveFileMenuSeam), each(deriveWorkspaceFileMenuSeam), each(deriveTabMenuSeam), each(deriveLauncherSeam), each(deriveMarkdownSeam), each(deriveMarkdownTextSeam), each(deriveSidebarGroupsSeam), each(deriveTabVisibleSeam), each(deriveResponsiveSeam), each(derivePageRouteSeam), each(deriveDestinationsSeam), each(deriveRailModeSeam), copy, each((c) => deriveCopyOrigins(c, copy.helper)), each(deriveCommandSeam), each(deriveAttachSeam), each(deriveReviewActionSeam), each(derivePullRequestCreateSeam), each(deriveMcpRowProps), each(deriveModelMenuProps), each(deriveBranchListProps), deriveAppHostSeam(source), deriveMenuCommandSeam(source), deriveMainModulesSeam(source)]) { if (r.group) groups.push(r.group); missing.push(...r.missing); }
  const ex = deriveExposures(corpus);
  groups.push(...ex.groups); missing.push(...ex.missing);
  return { groups, drafts: groups.flatMap((g) => g.drafts), missing, exposures: ex.exposures };
}

/**
 * The site an edit id names: without a copy's suffix (`eachCopy`: `<id>@<chunk role>`, the same edit in another chunk's copy of an rspack module) and
 * without `:end`, the closing half of a wrapper made around an anonymous function (`wrapFunction`: a head edit and an end edit are one seam).
 */
export const siteOf = (id) => String(id).replace(/@[^@:]*$/, '').replace(/:end$/, '');

/** The pack's `seams.hooks` declaration for the UI seam transforms that are in `transforms`: what applied, with the ABI of the hook names. */
export function declarationFor(transforms) {
  const ids = (kind) => transforms.filter((t) => t.seam === kind).map((t) => t.id);
  const exposures = {};
  // an rspack module's copies each carry its block: a key is declared by its first block
  for (const t of transforms.filter((x) => x.seam === 'expose')) for (const k of exposedKeys(t.text)) exposures[k] ??= t.id;
  const taps = ids('tap');
  const decl = { abi: ABI };
  if (ids('jsx').length) decl.jsx = ids('jsx')[0];
  if (ids('lazy').length) decl.lazy = ids('lazy')[0];
  if (taps.length) decl.taps = taps;
  if (ids('menu').includes('seam-menu')) decl.menuItems = 'seam-menu';
  // the menus hook's other kinds (E8.7): each a seam of its own
  const kinds = ids('menu').filter((id) => id.startsWith('seam-menu:') && siteOf(id) === id);
  if (kinds.length) decl.menuKinds = Object.fromEntries(kinds.map((id) => [id.slice('seam-menu:'.length), id]));
  if (ids('launcher').length) decl.launcher = ids('launcher')[0];
  if (ids('markdown').length) decl.markdown = ids('markdown');
  if (ids('props').length) decl.props = ids('props');   // identity props (H7v): no hook, what the bindings may read
  if (ids('app-host').length) decl.appHost = ids('app-host')[0];
  if (ids('main-modules').length) decl.mainModules = ids('main-modules')[0];
  if (ids('copy').length) decl.copy = ids('copy')[0];
  if (ids('command').length) decl.command = ids('command')[0];
  if (ids('attach').length) decl.attach = ids('attach')[0];
  if (ids('review-action').length) decl.reviewAction = ids('review-action')[0];
  if (ids('pr-create').length) decl.pullRequestCreate = ids('pr-create')[0];
  if (ids('sidebar-groups').length) decl.sidebarGroups = ids('sidebar-groups')[0];
  if (ids('responsive').length) decl.responsive = ids('responsive')[0];
  if (ids('page-route').length) decl.pageRoute = ids('page-route')[0];
  if (ids('destinations').length) decl.destinations = ids('destinations')[0];
  if (ids('rail-mode').length) decl.railMode = ids('rail-mode')[0];
  if (ids('tab-visible').length) decl.tabVisible = ids('tab-visible')[0];
  if (Object.keys(exposures).length) decl.exposures = exposures;
  return Object.keys(decl).length > 1 ? decl : null;
}

/** The transform kinds that are UI seams: derived again for every build (never replayed from an older pack), applied as atomic groups. */
export const UI_SEAM_KINDS = Object.freeze(['jsx', 'lazy', 'tap', 'menu', 'launcher', 'markdown', 'props', 'expose', 'app-host', 'copy', 'copy-origin', 'command', 'attach', 'review-action', 'pr-create', 'menu-command', 'main-modules', 'sidebar-groups', 'tab-visible', 'responsive', 'page-route', 'destinations', 'rail-mode']);
export const isUiSeam = (t) => UI_SEAM_KINDS.includes(t.seam);

/**
 * Seal the drafts of `groups` onto the end of `prior` (an already sealed transform list; its hash chains continue). A group applies whole or not at all:
 * when one of its drafts no longer matches exactly once after the transforms before it, the group is dropped and reported.
 * @returns {{ transforms: object[], applied: string[], dropped: {id: string, why: string}[] }}
 */
export function sealGroupsAfter(prior, groups, readFile) {
  const outputs = applyAll(prior, readFile);
  const transforms = [...prior]; const applied = []; const dropped = [];
  for (const g of groups) {
    const scratch = new Map(outputs); const sealed = [];
    try {
      for (const d of g.drafts) {
        const before = scratch.has(d.file) ? scratch.get(d.file) : readFile(d.file);
        const after = applyOp(before, d);
        scratch.set(d.file, after);
        sealed.push({ id: d.id, seam: d.seam, file: d.file, sha256Before: sha256(before), sha256After: sha256(after), op: d.op, find: d.find, text: d.text });
      }
    } catch (e) { dropped.push({ id: g.id, why: String(e.message).split('\n')[0] }); continue; }
    for (const [f, t] of scratch) outputs.set(f, t);
    transforms.push(...sealed); applied.push(g.id);
  }
  return { transforms, applied, dropped };
}

/** `missing` entries (the shape the generator and the refresh report) for the groups `sealGroupsAfter` dropped. */
export const droppedAsMissing = (dropped) => dropped.map((d) => ({ item: `seam-group:${d.id}`, tried: `the group no longer applies after the other transforms: ${d.why}` }));

/**
 * The UI seams of `source` appended to `prior` (a sealed transform list): derived as atomic groups, each applied whole or dropped and reported.
 * The generator and the pack re-seam tool call this; the refresh does the same over its in-memory files.
 * @returns {{ transforms: object[], hooks: object|null, applied: string[], dropped: object[], missing: object[], exposures: object[], drafts: object[] }}
 */
export function applyUiSeams(source, prior) {
  const ui = deriveUiSeams(source);
  const sealed = sealGroupsAfter(prior, ui.groups, (p) => source.read(p));
  return { transforms: sealed.transforms, hooks: declarationFor(sealed.transforms), applied: sealed.applied, dropped: sealed.dropped, missing: [...ui.missing, ...droppedAsMissing(sealed.dropped)], exposures: ui.exposures, drafts: ui.drafts };
}
