// The UI seam derivers (seams.mjs; docs/design/presentations.md V1, V2): synthetic fixtures (absent, duplicated and changed anchors give `missing`, never a guess),
// a VM run of every seam's text (hook absent: the stock behaviour; hook throwing: fall back and count), real-substrate tests against the stock builds
// (20770 from the extraction `.tmp/asar-20770/`, 21477 from the installed app), and a drift report against 20156.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { originOnly } from './pack-tests.mjs';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ABI, HOOKS, JSX_RE, LAZY_RE, TAP_TABLE_RE, TAP_HANDLERS_RE, TAP_MESSAGES_RE, MENU_RE, APP_HOST_RE, EXPOSURES, chainEnd, corpusOf, declarationFor, deriveAppHostSeam, deriveMainModulesSeam, deriveExposures, deriveJsxSeam,
  deriveLazySeam, deriveTapSeams, deriveMenuSeam, deriveLauncherSeam, deriveFileMenuSeam, deriveWorkspaceFileMenuSeam, deriveTabMenuSeam, deriveMarkdownSeam, deriveCopySeam, deriveCopyOrigins, deriveCommandSeam, deriveAttachSeam, deriveReviewActionSeam, derivePullRequestCreateSeam, deriveUiSeams, exposedKeys, exposureText, isUiSeam, rx, sealGroupsAfter, applyUiSeams,
} from './seams.mjs';
import { derivePageRouteSeam, deriveDestinationsSeam, deriveRailModeSeam } from './seams.mjs';
import { matchClose as scanClose, enclosingFunction } from './scan.mjs';
import { applyAll, applyOp, fileStem, sealTransforms } from './transform.mjs';
import { locateStock, sourceFromDir } from './stock.mjs';
import { synth, MAP, JSX_WRAPPER, VITE_HELPER, MENU_BUILDER, LAUNCHER_FILTER, FILE_MENU_BUILDER, WORKSPACE_FILE_MENU_BUILDER, TAB_MENU_BUILDER, MD_COMPONENTS_BUILDER, MD_DIRECTIVES_BUILDER, FIXTURE, fx } from './fixtures/seam-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..');

// ------------------------------------------------------------------------------------------------ synthetic fixtures
const replaceInFile = (file, from, to) => ({ [file]: FIXTURE[file].replace(from, to) });
const messagesOf = (r) => r.missing.map((m) => m.item);

test('the hook API and its anchors are exported for the kernel, the census and the tests', () => {
  assert.equal(ABI, 1);
  assert.deepEqual(Object.keys(HOOKS), ['jsx', 'lazy', 'taps', 'menuItems', 'launcher', 'markdownComponents', 'markdownDirectives', 'markdownText', 'pullRequestCreate', 'reviewAction', 'attach', 'command', 'destinations', 'useDestinationsRev', 'destinationsRev', 'railMode', 'PageRoute', 'responsive', 'sidebarGroups', 'copy', 'appHost', 'mainModules', 'exports', 'faults']);
  for (const re of [JSX_RE, LAZY_RE, TAP_TABLE_RE, TAP_HANDLERS_RE, TAP_MESSAGES_RE, MENU_RE, APP_HOST_RE]) assert.ok(re instanceof RegExp && re.global);
  assert.equal(EXPOSURES.length, 80);
  assert.equal(new Set(EXPOSURES.map((e) => e.key)).size, EXPOSURES.length);
});

test('the scanner skips regex literals that hold quotes and backticks (a class such as [^"\'`] must not open a string)', () => {
  const s = 'function f(){var r=/[^"\'`]+/g,x=1;return{a:r}}function g(){return 2}';
  assert.equal(scanClose(s, s.indexOf('{')), s.indexOf('}function g') );
  assert.deepEqual(enclosingFunction(s, s.indexOf('x=1')), { name: 'f', start: 0, end: s.indexOf('}function g') });
  assert.equal(scanClose('a(b[c]{d:"}"},`${")"}`)e', 1), 'a(b[c]{d:"}"},`${")"}`)'.length - 1);
  assert.equal(chainEnd('.a(1).b({c:")"}).d(2)x', 0), '.a(1).b({c:")"}).d(2)'.length);
  assert.equal(chainEnd('x', 0), 0);
});

test('rx: @name@ is a capture on first use and a back-reference after', () => {
  const m = rx('@a@=@b@\\(\\k<a>\\)').exec('x=f(x)');
  assert.deepEqual({ ...m.groups }, { a: 'x', b: 'f' });
  assert.equal(rx('@a@=@a@').exec('x=y'), null);
});

// ------------------------------------------------------------------------------------------------ derivers on synthetic fixtures
test('jsx: derives one replace-once of the factory wrapper; absent, duplicated or changed anchors are missing, never a guess', () => {
  const ok = deriveJsxSeam(corpusOf(fx()));
  assert.deepEqual(ok.missing, []);
  const [d] = ok.group.drafts;
  assert.deepEqual([d.id, d.seam, d.op, d.file, d.find], ['seam-jsx', 'jsx', 'replace-once', 'webview/assets/app-shared-aaaaaaaaaaaa.js', 'e.Fragment=n,e.jsx=r,e.jsxs=r}']);
  assert.match(d.text, /^e\.Fragment=n,e\.jsx=e\.jsxs=function\(/);
  // absent
  assert.deepEqual(messagesOf(deriveJsxSeam(corpusOf(fx(replaceInFile('webview/assets/app-shared-aaaaaaaaaaaa.js', 'e.jsxs=r}', 'e.jsxs=q}'))))), ['seam:jsx']);
  // duplicated (a second copy of the wrapper in another renderer chunk)
  assert.deepEqual(messagesOf(deriveJsxSeam(corpusOf(fx({ 'webview/assets/other-dddddddddddd.js': JSX_WRAPPER })))), ['seam:jsx']);
  // changed: jsx and jsxs are no longer the same function
  assert.deepEqual(messagesOf(deriveJsxSeam(corpusOf(fx(replaceInFile('webview/assets/app-shared-aaaaaaaaaaaa.js', 'e.jsxs=r}', 'e.jsxs=n}'))))), ['seam:jsx']);
  // the main-process copy (the in-app browser's page preload) is not a renderer seam
  assert.deepEqual(messagesOf(deriveJsxSeam(corpusOf(synth({ '.vite/build/browser-page-preload.js': JSX_WRAPPER })))), ['seam:jsx']);
});

test('lazy: derives the preload helper by its shape and its single vite:preloadError event; absent, duplicated, changed or unguarded is missing', () => {
  const f = 'webview/assets/app-shared-aaaaaaaaaaaa.js';
  const ok = deriveLazySeam(corpusOf(fx()));
  assert.deepEqual(ok.missing, []);
  const [d] = ok.group.drafts;
  assert.deepEqual([d.id, d.seam, d.op], ['seam-lazy', 'lazy', 'replace-once']);
  assert.equal(d.find, 'nh=function(e,t,n){let r=Promise.resolve();if(t&&t.length>0){let e=document.getElementsByTagName(`link`)');
  assert.ok(d.text.endsWith(d.find.slice(d.find.indexOf('let r='))) , 'the helper\'s own statements follow the wrapper unchanged');
  assert.deepEqual(messagesOf(deriveLazySeam(corpusOf(fx(replaceInFile(f, 'Promise.resolve();if(t&&t.length>0)', 'Promise.resolve();if(t)'))))), ['seam:lazy']);
  assert.deepEqual(messagesOf(deriveLazySeam(corpusOf(fx({ 'webview/assets/other-dddddddddddd.js': `${VITE_HELPER}` })))), ['seam:lazy']);
  assert.deepEqual(messagesOf(deriveLazySeam(corpusOf(fx(replaceInFile(f, 'vite:preloadError', 'vite:preloadFail'))))), ['seam:lazy']);
  assert.match(deriveLazySeam(corpusOf(fx(replaceInFile(f, 'new Event(`vite:preloadError`', 'new Event(`vite:preloadError`+`vite:preloadError`')))) .missing[0].tried, /2 `vite:preloadError`/);
});

test('F3 copy: one replace-once of the app\'s copy helper (asynchronous, its name kept): the hook sees what is copied and the helper copies what it answers; none, null or a throw: the content as it was', async () => {
  const HELPER = 'async function tTn(e,t,n){e instanceof Promise&&e.catch(()=>{});let{navigator:r,document:i}=t?.target?.ownerDocument?.defaultView??window,a=i.hasFocus();let c=typeof e==`string`?e:e instanceof Promise?await e:e[`text/plain`];return globalThis.copied=c,n?.(),!0}';
  const file = 'webview/assets/app-shared-aaaaaaaaaaaa.js';
  const ok = deriveCopySeam(corpusOf(synth({ [file]: `let q=1;${HELPER}export{tTn as NO};\n${MAP}` })));
  assert.deepEqual(ok.missing, []);
  const [d] = ok.group.drafts;
  assert.deepEqual([ok.group.id, d.id, d.seam, d.file, d.find], ['copy', 'seam-copy', 'copy', file, 'async function tTn(e,t,n){']);
  assert.deepEqual(messagesOf(deriveCopySeam(corpusOf(synth({ [file]: `${HELPER}${HELPER.replace('tTn', 'uTn')}\n${MAP}` })))), ['seam:copy'], 'two: no pick');
  const run = async (hooks, content) => {
    const ctx = { globalThis: null, window: { navigator: {}, document: { hasFocus: () => true } } };
    ctx.globalThis = ctx;
    if (hooks) ctx.__codexmods = hooks;
    vm.runInNewContext(`${applyOp(HELPER, d)};globalThis.f=tTn;`, ctx);
    // a promise is the page's own (the helper tells one by its realm's Promise)
    const r = await ctx.f(typeof content === 'function' ? content(vm.runInNewContext('Promise', ctx)) : content, null, () => { ctx.done = true; });
    return [r, ctx.copied, ctx.done === true];
  };
  assert.deepEqual(await run(null, 'key sk-1'), [true, 'key sk-1', true], 'no hook: as it was');
  const seen = [];
  assert.deepEqual(await run({ copy: (c, e, o) => { seen.push([c, e, o]); return 'key •••'; } }, 'key sk-1'), [true, 'key •••', true]);
  assert.deepEqual(seen, [['key sk-1', null, undefined]], 'what is copied, its event, and no origin (the helper\'s own callers give none)');
  assert.deepEqual(await run({ copy: (c) => ({ ...c, 'text/plain': 'masked' }) }, { 'text/plain': 'raw', 'text/html': '<p>m</p>' }), [true, 'masked', true]);
  assert.deepEqual(await run({ copy: (c) => c.then(() => 'later') }, (P) => P.resolve('raw')), [true, 'later', true], 'a promise answered for a promise');
  assert.deepEqual(await run({ copy: () => null }, 'raw'), [true, 'raw', true], 'null: as it was');
  const faults = {};
  assert.deepEqual(await run({ copy: () => { throw new Error('x'); }, faults }, 'raw'), [true, 'raw', true], 'a throw: as it was');
  assert.equal(faults.copy, 1);
});

test('F3 copy origins (built review round 2): the thread actions\' calls to the copy helper (imported under its export\'s name) are given where their content is from, a data-only fourth argument; a call of another function, or a site not found, is missing', async () => {
  const shared = 'webview/assets/app-shared-aaaaaaaaaaaa.js', initial = 'webview/assets/app-initial-bbbbbbbbbbbb.js';
  const HELPER = 'async function tTn(e,t,n){e instanceof Promise&&e.catch(()=>{});let{navigator:r,document:i}=t?.target?.ownerDocument?.defaultView??window;return!0}';
  const MD = 'function ubo({scope:e,conversationId:t,parentConversationId:n,getMarkdown:r,intl:i}){(async()=>{await gh(e,e.get(yk,t)).ensureConversationHistoryLoaded(t,n==null?[]:[n]);let a=await r();a!=null&&a.trim().length!==0&&await Vi(a)&&e.get(nl).success(i.formatMessage(mY.copyConversationMarkdownSuccess))})()}';
  const WD = 'function sbo({scope:e,cwd:t,thread:n,intl:r}){(async()=>{let i=t;n!=null&&e.get(GE,n.hostId)&&(await GZn(e,n),i=e.get(QZn,n)?.data?.latestWorktree?.workspaceRoot??t),i&&await Vi(i)&&e.get(nl).success(r.formatMessage(mY.copyWorkingDirectorySuccess))})()}';
  const LINK = 'let u=(e,t,r)=>{if(e==null)return;let i=t??`local`;Vi(gh(n,i).getFollowUpContext(Ol(e)).catch(fbo).then(t=>lbo(e,i,t?.threadAccess??r)))};';
  const files = (imp) => synth({ [shared]: `${HELPER}export{tTn as NO};\n${MAP}`, [initial]: `import{NO as ${imp}}from"./app-shared-aaaaaaaaaaaa.js";${MD}${WD}${LINK}\n${MAP}` });
  const corpus = corpusOf(files('Vi'));
  const helper = deriveCopySeam(corpus).helper;
  const ok = deriveCopyOrigins(corpus, helper);
  assert.deepEqual(ok.missing, []);
  assert.deepEqual(ok.group.drafts.map((d) => [d.id, d.seam, d.file, d.text.slice(d.find.length - 8)]).map(([id, seam, file]) => [id, seam, file]),
    [['seam-copy-origin:markdown', 'copy-origin', initial], ['seam-copy-origin:folder', 'copy-origin', initial], ['seam-copy-origin:link', 'copy-origin', initial]]);
  const [md, wd, link] = ok.group.drafts;
  assert.equal(md.text, md.find.replace(/await Vi\(a\)$/, 'await Vi(a,void 0,void 0,{chat:t})'));
  assert.ok(wd.text.startsWith('i&&await Vi(i,void 0,void 0,{content:!1})&&e.get(nl)'));
  assert.ok(link.text.endsWith('t?.threadAccess??r)),void 0,void 0,{content:!1})}'));
  for (const d of ok.group.drafts) assert.ok(originOnly(d), `${d.id}: data only`);
  // the origin reaches the hook through the helper's wrapper
  const [h] = deriveCopySeam(corpus).group.drafts;
  const ctx = { window: { navigator: {}, document: { hasFocus: () => true } }, seen: [] };
  ctx.globalThis = ctx;
  ctx.__codexmods = { copy: (c, e, o) => { ctx.seen.push([c, o]); return null; } };
  vm.runInNewContext(`${applyOp(HELPER, h)};globalThis.f=tTn;`, ctx);
  await ctx.f('md', void 0, void 0, { chat: 't1' });
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.seen)), [['md', { chat: 't1' }]]);
  // the calls must be the helper's: another import under that local name is not
  const other = corpusOf(synth({ [shared]: `${HELPER}export{tTn as NO,uTn as NP};\n${MAP}`, [initial]: `import{NP as Vi}from"./app-shared-aaaaaaaaaaaa.js";${MD}${WD}${LINK}\n${MAP}` }));
  assert.deepEqual(messagesOf(deriveCopyOrigins(other, deriveCopySeam(other).helper)), ['seam:copy-origin:markdown', 'seam:copy-origin:folder', 'seam:copy-origin:link']);
  assert.equal(deriveCopyOrigins(corpus, undefined).group, null, 'no copy seam: no origins');
});

test('H6m4 review action: one replace-once of the review panel\'s git action (asynchronous, its name kept): the hook is asked first with its argument and its run; anything but undefined is its answer; once it ran it never runs again', async () => {
  const ACTION = 'async function Ms({scope:e,cwd:t,diffText:n,hostConfig:r,params:i,reviewFiles:a,refreshPathsFast:o,stageFilter:l}){globalThis.ran.push([t,i.action]);return`done`}';
  const file = 'webview/assets/thread-side-panel-tab-content-aaaaaaaaaaaa.js';
  const ok = deriveReviewActionSeam(corpusOf(synth({ [file]: `${ACTION}export{Ms as t};\n${MAP}` })));
  assert.deepEqual(ok.missing, []);
  const [d] = ok.group.drafts;
  assert.deepEqual([ok.group.id, d.id, d.seam, d.find], ['review-action', 'seam-review-action', 'review-action', 'async function Ms({scope:e,cwd:t,diffText:n,hostConfig:r,params:i,reviewFiles:a,']);
  assert.deepEqual(messagesOf(deriveReviewActionSeam(corpusOf(synth({ [file]: `f({scope:a,cwd:b,diffText:c,hostConfig:d,params:e,reviewFiles:g,x:1});\n${MAP}` })))), ['seam:review-action'], 'a call is not the action');
  const run = async (hooks) => {
    const ctx = { ran: [] };
    ctx.globalThis = ctx;
    if (hooks) ctx.__codexmods = hooks;
    vm.runInNewContext(`${applyOp(ACTION, d)};globalThis.f=Ms;`, ctx);
    const r = await ctx.f({ scope: null, cwd: '/repo', params: { action: 'revert', scope: 'file', path: 'a.js' }, reviewFiles: [] });
    return [r, JSON.parse(JSON.stringify(ctx.ran))];
  };
  assert.deepEqual(await run(null), ['done', [['/repo', 'revert']]], 'no hook: the app\'s own');
  let later;
  assert.deepEqual(await run({ reviewAction: (a, go) => { later = go; return Promise.resolve('held'); } }), ['held', []], 'held: answered, not run');
  assert.equal(await later(), 'done', 'its own run, later');
  assert.deepEqual(await run({ reviewAction: () => undefined }), ['done', [['/repo', 'revert']]], 'undefined: the app\'s own');
  assert.deepEqual(await run({ reviewAction: (a, go) => { go(); return undefined; } }), [undefined, [['/repo', 'revert']]], 'ran by the hook: never again');
  const faults = {};
  assert.deepEqual(await run({ reviewAction: () => { throw new Error('x'); }, faults }), ['done', [['/repo', 'revert']]]);
  assert.equal(faults.reviewAction, 1);
});

test('H6m4 pull request create: before the creation\'s route (the gh CLI or the GitHub connector) the hook is asked; a reason it answers is thrown, a pull request a mod made is the answer, as the app\'s success is; none or a throw: the app\'s own', async () => {
  const MUT = 'async function mut(e,n,s,t,o){let x=0,c=s?.status===`success`?s.account:null,l=t.query.snapshot(Ue,{cwd:e.cwd,headBranch:n.headBranch,hostId:e.hostId,operationSource:n.operationSource}).queryKey;switch(n.signal?.throwIfAborted(),o){case`github-cli`:{globalThis.ran.push([`cli`,n.headBranch]);return{number:1,url:`u1`,account:c,provider:o,discoveryQueryKey:l}}case`github-connector`:{globalThis.ran.push([`connector`,n.headBranch]);return{number:2}}}}';
  const file = 'webview/assets/git-action-new-branch-field-aaaaaaaaaaaa.js';
  const ok = derivePullRequestCreateSeam(corpusOf(synth({ [file]: `${MUT}\n${MAP}` })));
  assert.deepEqual(ok.missing, []);
  const [d] = ok.group.drafts;
  assert.deepEqual([ok.group.id, d.id, d.seam], ['pr-create', 'seam-pr-create', 'pr-create']);
  const run = async (hooks, route) => {
    const ctx = { ran: [] };
    ctx.globalThis = ctx;
    if (hooks) ctx.__codexmods = hooks;
    vm.runInNewContext(`var Ue={};${applyOp(MUT, d)};globalThis.f=mut;`, ctx);
    const query = { snapshot: () => ({ queryKey: ['k'] }) };
    let r, error = null;
    try { r = await ctx.f({ cwd: '/repo', hostId: 'local' }, { headBranch: 'feat', baseBranch: 'main', isDraft: false }, { status: 'success', account: 'acc' }, { query }, route); } catch (e) { error = e.message; }
    return JSON.parse(JSON.stringify({ r: r ?? null, error, ran: ctx.ran }));
  };
  assert.deepEqual(await run(null, 'github-connector'), { r: { number: 2 }, error: null, ran: [['connector', 'feat']] }, 'no hook: the app\'s own route');
  const seen = [];
  assert.deepEqual(await run({ pullRequestCreate: (a) => { seen.push(a); return Promise.resolve({ refused: 'No pull request: frozen' }); } }, 'github-connector'), { r: null, error: 'No pull request: frozen', ran: [] }, 'refused: thrown, neither route');
  assert.deepEqual(JSON.parse(JSON.stringify(seen[0])), { cwd: '/repo', hostId: 'local', headBranch: 'feat', baseBranch: 'main', isDraft: false, source: 'github-connector' });
  assert.deepEqual(await run({ pullRequestCreate: () => ({ handled: { url: 'https://github.com/o/r/pull/9', number: 9 } }) }, 'github-cli'),
    { r: { number: 9, url: 'https://github.com/o/r/pull/9', account: 'acc', provider: 'github-cli', discoveryQueryKey: ['k'] }, error: null, ran: [] }, 'a mod\'s own: the answer');
  assert.deepEqual((await run({ pullRequestCreate: () => undefined }, 'github-cli')).ran, [['cli', 'feat']], 'undefined: the app\'s own');
});

test('H6m3b attach: one replace-once of the composer\'s attach factory (its name kept): the hook is given the methods it made and its arguments; an object answered is used in their place; none, anything else or a throw: the app\'s own', () => {
  const FACTORY = 'function REd({scope:e,attachmentGeneration:t,canceledPendingFileAttachmentIds:n,intl:l,shouldRestrict:h=!1}){return{addFiles:(f)=>globalThis.ran.push([e,f]),addImageDataUrls:()=>!0}}';
  const file = 'webview/assets/app-initial-aaaaaaaaaaaa.js';
  const ok = deriveAttachSeam(corpusOf(synth({ [file]: `let q=1;${FACTORY}export{REd as Pr};\n${MAP}` })));
  assert.deepEqual(ok.missing, []);
  const [d] = ok.group.drafts;
  assert.deepEqual([ok.group.id, d.id, d.seam, d.find], ['attach', 'seam-attach', 'attach', 'function REd({scope:e,attachmentGeneration:t,']);
  assert.deepEqual(messagesOf(deriveAttachSeam(corpusOf(synth({ [file]: `${FACTORY}${FACTORY.replace('REd', 'SEd')}\n${MAP}` })))), ['seam:attach'], 'two: no pick');
  // a caller's call (its arguments named so too) is not the factory
  assert.deepEqual(messagesOf(deriveAttachSeam(corpusOf(synth({ [file]: `f({scope:a,attachmentGeneration:b,canceledPendingFileAttachmentIds:c.current,intl:d});\n${MAP}` })))), ['seam:attach']);
  const run = (hooks) => {
    const ctx = { ran: [] };
    ctx.globalThis = ctx;
    if (hooks) ctx.__codexmods = hooks;
    vm.runInNewContext(`${applyOp(FACTORY, d)};globalThis.m=REd({scope:'S',attachmentGeneration:{current:0},canceledPendingFileAttachmentIds:[],intl:null});globalThis.m.addFiles(['a']);`, ctx);
    return ctx;
  };
  assert.deepEqual(JSON.parse(JSON.stringify(run(null).ran)), [['S', ['a']]], 'no hook: the app\'s own');
  const seen = [];
  const held = run({ attach: (m, a) => { seen.push([Object.keys(m).sort(), a.scope]); return { ...m, addFiles: (f) => globalThis.ran?.push(['held', f]) }; } });
  assert.deepEqual(JSON.parse(JSON.stringify([seen, held.m.addImageDataUrls()])), [[[['addFiles', 'addImageDataUrls'], 'S']], true]);
  assert.deepEqual(JSON.parse(JSON.stringify(run({ attach: () => null }).ran)), [['S', ['a']]], 'null: the app\'s own');
  const faults = {};
  assert.deepEqual(JSON.parse(JSON.stringify(run({ attach: () => { throw new Error('x'); }, faults }).ran)), [['S', ['a']]], 'a throw: the app\'s own');
  assert.equal(faults.attach, 1);
});

test('H6m3 command: one replace-once of the page\'s command dispatcher (its name kept): the hook is asked first with the dispatch as the app does it; a boolean answered is the answer; none, anything else or a throw: the app\'s own dispatch', () => {
  const DISPATCH = 'function ACr(e,t,n,r){let i=nwr.get(e);for(let e of[`normal`,`fallback`])for(let a=(i?.length??0)-1;a>=0;a--){let o=i?.[a];if(o?.priority===e&&o.isActive(r)&&o.handler(n,t,r)!==!1)return!0}return globalThis.ran.push([e,n]),!1}';
  const file = 'webview/assets/app-initial-aaaaaaaaaaaa.js';
  const ok = deriveCommandSeam(corpusOf(synth({ [file]: `var nwr=new Map;${DISPATCH}\n${MAP}` })));
  assert.deepEqual(ok.missing, []);
  const [d] = ok.group.drafts;
  assert.deepEqual([ok.group.id, d.id, d.seam, d.find], ['command', 'seam-command', 'command', 'function ACr(e,t,n,r){']);
  assert.deepEqual(messagesOf(deriveCommandSeam(corpusOf(synth({ [file]: `${DISPATCH}${DISPATCH.replace('ACr', 'BCr')}\n${MAP}` })))), ['seam:command'], 'two: no pick');
  const run = (hooks, ...args) => {
    const ctx = { globalThis: null, ran: [] };
    ctx.globalThis = ctx;
    if (hooks) ctx.__codexmods = hooks;
    vm.runInNewContext(`var nwr=new Map;${applyOp(DISPATCH, d)};globalThis.f=ACr;`, ctx);
    return [ctx.f(...args), ctx.ran.map((x) => [...x])];
  };
  assert.deepEqual(run(null, 'newTask', undefined, 'command_menu', undefined), [false, [['newTask', 'command_menu']]], 'no hook: the app\'s own');
  const seen = [];
  const later = [];
  assert.deepEqual(run({ command: (id, ev, source, origin, dispatch) => { seen.push([id, source]); later.push(dispatch); return true; } }, 'deleteChat', undefined, 'keyboard_shortcut', undefined), [true, []], 'held: answered handled, not run');
  assert.deepEqual(seen, [['deleteChat', 'keyboard_shortcut']]);
  assert.equal(later[0](), false, 'the dispatch as the app does it, run later by the hook');
  assert.deepEqual(run({ command: () => undefined }, 'x', undefined, 's', undefined), [false, [['x', 's']]], 'undefined: the app\'s own');
  const faults = {};
  assert.deepEqual(run({ command: () => { throw new Error('x'); }, faults }, 'x', undefined, 's', undefined)[0], false);
  assert.equal(faults.command, 1);
  // once it ran it never runs again (built review H6m3a): a non-boolean answer is the run's own; a throw is the dispatcher's
  assert.deepEqual(run({ command: (id, ev, s, o, dispatch) => { dispatch(); return 'ran'; } }, 'y', undefined, 's', undefined), [false, [['y', 's']]], 'run once');
  assert.throws(() => run({ command: (id, ev, s, o, dispatch) => { dispatch(); throw new Error('boom'); }, faults }, 'z', undefined, 's', undefined), /boom/);
  assert.equal(faults.command, 1, 'not a fault of the hook\'s: no second run');
  // an event given replaces the one it had (a held key chord's, handled when the hold answered)
  const events = [];
  const ctx = { ran: [] };
  ctx.globalThis = ctx;
  ctx.__codexmods = { command: (id, ev, s, o, dispatch) => { events.push(ev); later.push(dispatch); return true; } };
  vm.runInNewContext(`var nwr=new Map([['k',[{priority:'normal',isActive:()=>!0,handler:(n,t)=>{globalThis.ran.push(t);return!0}}]]]);${applyOp(DISPATCH, d)};globalThis.f=ACr;`, ctx);
  assert.equal(ctx.f('k', 'old-event', 'keyboard_shortcut', undefined), true);
  assert.equal(later.at(-1)('fresh-event'), true);
  assert.deepEqual([...ctx.ran], ['fresh-event']);
});

test('E8.7 file menu: one replace-once of the file tree\'s menu builder (synchronous, its name kept); the hook gets its items with the kind "file-tree"', () => {
  const ok = deriveFileMenuSeam(corpusOf(fx()));
  assert.deepEqual(ok.missing, []);
  const [d] = ok.group.drafts;
  assert.deepEqual([ok.group.id, d.id, d.seam, d.find], ['file-menu', 'seam-menu:file-tree', 'menu', 'function ke({isLoadingOpenTargets:']);
  assert.deepEqual(messagesOf(deriveFileMenuSeam(corpusOf(fx({ 'webview/assets/other-eeeeeeeeeeee.js': FILE_MENU_BUILDER })))), ['seam:file-menu'], 'a second copy: no pick');
  const run = (hooks, args) => {
    const ctx = { globalThis: null };
    ctx.globalThis = ctx;
    if (hooks) ctx.__codexmods = hooks;
    vm.runInNewContext(`${applyOp(FILE_MENU_BUILDER, d)};globalThis.f=ke;`, ctx);
    return JSON.parse(JSON.stringify(ctx.f(args)));
  };
  assert.deepEqual(run(null, { targetPath: '/a' }).map((x) => x.id), ['add-to-chat', 'copy-path'], 'no hook: the app\'s items');
  const seen = [];
  assert.deepEqual(run({ menuItems: (a, items, kind) => { seen.push([a.targetPath, kind]); return [...items, { id: 'mod' }]; } }, { targetPath: '/a' }).map((x) => x.id), ['add-to-chat', 'copy-path', 'mod']);
  assert.deepEqual(seen, [['/a', 'file-tree']]);
  assert.deepEqual(run({ menuItems: () => { throw new Error('x'); }, faults: {} }, { targetPath: '/a' }).length, 2, 'a throw: the app\'s items');
  assert.deepEqual(run({ menuItems: () => [{ id: 'never' }] }, { targetPath: null }), [], 'no path: the app\'s empty list, the hook not asked');
});

test('E8.8 markdown: the two map builders keep their names; the hook gets the call\'s options and the app\'s map; absent, throwing or not an object, the app\'s own', () => {
  const ok = deriveMarkdownSeam(corpusOf(fx()));
  assert.deepEqual(ok.missing, []);
  assert.deepEqual([ok.group.id, ...ok.group.drafts.map((d) => [d.id, d.seam, d.find])], ['markdown', ['seam-markdown:components', 'markdown', 'function xSd({allowWideBlocks:'], ['seam-markdown:directives', 'markdown', 'function bSd({conversationId:']]);
  const run = (hooks) => {
    const ctx = { globalThis: null };
    ctx.globalThis = ctx;
    if (hooks) ctx.__codexmods = hooks;
    let text = `${MD_DIRECTIVES_BUILDER}${MD_COMPONENTS_BUILDER}`;
    for (const d of ok.group.drafts) text = applyOp(text, d);
    vm.runInNewContext(`${text};globalThis.c=xSd({allowWideBlocks:!1,conversationId:'t',cwd:'/w',externalLinkAppearance:1,externalResourcePolicy:1,hostId:'h'});globalThis.d=bSd({conversationId:'t',cwd:'/w',enableInlineDil:!0,hostId:'h',turnId:'u'})`, ctx);
    return JSON.parse(JSON.stringify({ c: ctx.c, d: ctx.d, faults: ctx.__codexmods?.faults }));
  };
  assert.deepEqual(run(null), { c: { a: { link: 't' }, code: { code: '/w' } }, d: { appnote: { x: 't' }, dil: 1 } }, 'no hooks: the app\'s maps');
  const seen = [];
  const out = run({ markdownComponents: (o, c) => { seen.push(['c', o.cwd]); return { ...c, a: 'mine' }; }, markdownDirectives: (o, d) => { seen.push(['d', o.turnId]); return { ...d, chart: 1 }; } });
  assert.deepEqual(out.c, { a: 'mine', code: { code: '/w' } });
  assert.deepEqual(out.d, { appnote: { x: 't' }, dil: 1, chart: 1 });
  assert.deepEqual(seen, [['c', '/w'], ['d', 'u']]);
  const bad = run({ markdownComponents: () => { throw new Error('x'); }, markdownDirectives: () => 'no', faults: {} });
  assert.deepEqual([bad.c.a, bad.d.appnote, bad.faults], [{ link: 't' }, { x: 't' }, { markdown: 1 }], 'a throw or a non-object: the app\'s map (a throw counted)');
  assert.deepEqual(messagesOf(deriveMarkdownSeam(corpusOf(fx({ 'webview/assets/other-eeeeeeeeeeee.js': MD_COMPONENTS_BUILDER })))), ['seam:markdown:components'], 'a second copy: no pick, and the group is all or none');
});

test('E8.7b workspace file menu: one replace-once of the file reference menu builder (synchronous, its name kept); the hook gets the reference with the kind "workspace-file"', () => {
  const ok = deriveWorkspaceFileMenuSeam(corpusOf(fx()));
  assert.deepEqual(ok.missing, []);
  const [d] = ok.group.drafts;
  assert.deepEqual([ok.group.id, d.id, d.seam, d.find], ['workspace-file-menu', 'seam-menu:workspace-file', 'menu', 'function O$a(e,{artifactNavigationTarget:']);
  const run = (hooks, ref) => {
    const ctx = { globalThis: null };
    ctx.globalThis = ctx;
    if (hooks) ctx.__codexmods = hooks;
    vm.runInNewContext(`${applyOp(WORKSPACE_FILE_MENU_BUILDER, d)};globalThis.f=O$a;`, ctx);
    return JSON.parse(JSON.stringify(ctx.f({ scope: 1 }, ref)));
  };
  assert.deepEqual(run(null, { path: 'a.txt' }).map((x) => x.id), ['workspace-file-copy-path', 'workspace-file-reveal-path']);
  const seen = [];
  assert.deepEqual(run({ menuItems: (a, items, kind) => { seen.push([a.path, a.cwd, kind]); return [...items, { id: 'mod' }]; } }, { path: 'a.txt', cwd: '/w' }).map((x) => x.id).at(-1), 'mod');
  assert.deepEqual(seen, [['a.txt', '/w', 'workspace-file']]);
  assert.deepEqual(run({ menuItems: () => { throw new Error('x'); }, faults: {} }, { path: 'a.txt' }).length, 2, 'a throw: the app\'s items');
});

test('E8.7b tab menu: one replace-once of the panel tab menu builder (its name and its list-or-promise shape kept); the hook gets its arguments with the kind "tab"', async () => {
  const ok = deriveTabMenuSeam(corpusOf(fx()));
  assert.deepEqual(ok.missing, []);
  const [d] = ok.group.drafts;
  assert.deepEqual([ok.group.id, d.id, d.seam, d.find], ['tab-menu', 'seam-menu:tab', 'menu', 'function nQi({scope:']);
  const run = (hooks, tab) => {
    const ctx = { globalThis: null };
    ctx.globalThis = ctx;
    if (hooks) ctx.__codexmods = hooks;
    vm.runInNewContext(`${applyOp(TAB_MENU_BUILDER, d)};globalThis.f=nQi;`, ctx);
    return ctx.f({ scope: 1, controller: 2, tab });
  };
  const hook = { menuItems: (a, items, kind) => [...items, { id: `mod:${kind}:${a.tab.tabId}` }] };
  assert.deepEqual(JSON.parse(JSON.stringify(run(hook, { tabId: 'x' }))).map((x) => x.id), ['close-tab', 'close-other-tabs', 'mod:tab:x']);
  assert.deepEqual(JSON.parse(JSON.stringify(await run(hook, { tabId: 'y', async: true }))).map((x) => x.id), ['close-tab', 'mod:tab:y'], 'a promise of a list: the hook after it');
  assert.deepEqual(JSON.parse(JSON.stringify(run(null, { tabId: 'z' }))).length, 2, 'no hook: the app\'s items');
});

test('E8.2b launcher: one replace-once of the panels\' tool filter, which keeps its name; the hook adds to the list before the app\'s filter; absent, throwing or not a list, the app\'s list', () => {
  const ok = deriveLauncherSeam(corpusOf(fx()));
  assert.deepEqual(ok.missing, []);
  const [d] = ok.group.drafts;
  assert.deepEqual([ok.group.id, d.id, d.seam, d.op, d.find], ['launcher', 'seam-launcher', 'launcher', 'replace-once', 'function Bjl(e,{codexFeatureAccess:']);
  const initial = 'webview/assets/app-initial-bbbbbbbbbbbb.js';
  assert.deepEqual(messagesOf(deriveLauncherSeam(corpusOf(fx(replaceInFile(initial, 'showInNewTabLauncher===!1', 'showInLauncher===!1'))))), ['seam:launcher'], 'changed');
  assert.deepEqual(messagesOf(deriveLauncherSeam(corpusOf(fx({ 'webview/assets/other-dddddddddddd.js': LAUNCHER_FILTER })))), ['seam:launcher'], 'a second copy: no pick');
  const run = (hooks, list, opts) => {
    const ctx = { globalThis: null };
    ctx.globalThis = ctx;
    if (hooks) ctx.__codexmods = hooks;
    vm.runInNewContext(`${applyOp(LAUNCHER_FILTER, d)};globalThis.f=Bjl;`, ctx);
    return ctx.f(list, opts).map((x) => x.id);
  };
  const right = { dropDestinations: ['right'] }, both = { dropDestinations: ['right', 'bottom'] };
  const list = [{ id: 'terminal', tabType: both }, { id: 'browser', tabType: { ...right, showInNewTabLauncher: false } }];
  const opts = { codexFeatureAccess: { status: 'allowed' }, surface: 'new-tab', target: 'right' };
  assert.deepEqual(run(null, list, opts), ['terminal'], 'no hook: the app\'s filter alone');
  const seen = [];
  const mod = (l, o) => { seen.push(o); return [...l, { id: 'codexmods:m/v', tabType: both }, { id: 'codexmods:m/bottom-only', tabType: { dropDestinations: ['bottom'] } }]; };
  assert.deepEqual(run({ launcher: mod }, list, opts), ['terminal', 'codexmods:m/v'], 'the mods\' tools, still filtered by the app (target, new-tab rule)');
  assert.deepEqual(JSON.parse(JSON.stringify(seen)), [{ surface: 'new-tab', target: 'right' }], 'the hook gets the surface and target only');
  const faults = {};
  assert.deepEqual(run({ launcher: () => { throw new Error('x'); }, faults }, list, opts), ['terminal']);
  assert.equal(faults.launcher, 1, 'a throw is counted');
  assert.deepEqual(run({ launcher: () => 'nope' }, list, opts), ['terminal'], 'not a list: the app\'s');
});

test('menus: derives one replace-once of the item builder, which keeps its name; absent, duplicated or changed sites are missing, never a guess', async () => {
  const ok = deriveMenuSeam(corpusOf(fx()));
  assert.deepEqual(ok.missing, []);
  const [d] = ok.group.drafts;
  assert.deepEqual([ok.group.id, d.id, d.seam, d.op, d.file, d.find], ['menus', 'seam-menu', 'menu', 'replace-once', 'webview/assets/app-initial-bbbbbbbbbbbb.js', 'async function BUc({scope:']);
  const initial = 'webview/assets/app-initial-bbbbbbbbbbbb.js';
  assert.deepEqual(messagesOf(deriveMenuSeam(corpusOf(fx(replaceInFile(initial, 'showForkInSidebar:', 'showForkHere:'))))), ['seam:menus'], 'changed');
  assert.deepEqual(messagesOf(deriveMenuSeam(corpusOf(fx({ 'webview/assets/other-dddddddddddd.js': MENU_BUILDER })))), ['seam:menus'], 'a second copy: no pick');
  assert.deepEqual(messagesOf(deriveMenuSeam(corpusOf(fx(replaceInFile(initial, MENU_BUILDER, `${MENU_BUILDER}var BUc__cm;`))))), ['seam:menus'], 'the renamed builder\'s name is taken');
  // The patched builder in a VM: the hook absent, filtering, returning something else, throwing.
  const run = async (hooks) => {
    const ctx = { globalThis: null };
    ctx.globalThis = ctx;
    if (hooks) ctx.__codexmods = hooks;
    vm.runInNewContext(`${applyOp(MENU_BUILDER, d)};globalThis.f=BUc;`, ctx);
    return JSON.parse(JSON.stringify(await ctx.f({ scope: {}, target: { conversationId: 'c1' }, actions: {}, surface: 'sidebar' })));
  };
  const ids = (items) => items.map((x) => x.id);
  assert.deepEqual(ids(await run(null)), ['rename-thread', 'pin-thread', 'continuation-separator', 'fork', 'copy-separator', 'copy-actions'], 'no hook: the app\'s items');
  const seen = [];
  assert.deepEqual(ids(await run({ menuItems: (a, items) => { seen.push([a.target.conversationId, a.surface]); return items.filter((x) => x.id !== 'fork'); } })), ['rename-thread', 'pin-thread', 'continuation-separator', 'copy-separator', 'copy-actions']);
  assert.deepEqual(seen, [['c1', 'sidebar']], 'the hook gets the builder\'s argument');
  assert.equal((await run({ menuItems: () => 'nope' })).length, 6, 'not an array: the app\'s items');
  const faults = {};
  assert.equal((await run({ menuItems: () => { throw new Error('x'); }, faults })).length, 6, 'a throw: the app\'s items');
  assert.equal(faults.menuItems, 1, 'counted');
});

test('taps: the three command sites derive together; if any one is absent, duplicated or changed, none do', () => {
  const ok = deriveTapSeams(corpusOf(fx()));
  assert.deepEqual(ok.missing, []);
  assert.deepEqual(ok.group.drafts.map((d) => [d.id, d.seam, d.op, d.file.split('/').pop().replace(/-[0-9a-f]{12}\.js$/, '')]), [
    ['seam-tap:commands', 'tap', 'replace-once', 'app-initial'], ['seam-tap:handlers', 'tap', 'replace-once', 'app-initial'], ['seam-tap:messages', 'tap', 'replace-once', 'command-messages']]);
  const initial = 'webview/assets/app-initial-bbbbbbbbbbbb.js'; const msgs = 'webview/assets/command-messages-cccccccccccc.js';
  const cases = [
    ['commands absent', replaceInFile(initial, '[{id:`newTask`,', '[{id:`newTask2`,'), ['seam:tap:commands']],
    ['handlers absent', replaceInFile(initial, 'new Map([[`newTask`,', 'new Map([[`newTask2`,'), ['seam:tap:handlers']],
    ['messages changed', replaceInFile(msgs, '{...D,"codex', '{...D,...E,"codex'), ['seam:tap:messages']],
    ['commands duplicated', { 'webview/assets/other-dddddddddddd.js': 'z=[{id:`newTask`,' }, ['seam:tap:commands']],
    ['messages duplicated', { 'webview/assets/other-dddddddddddd.js': 'z={...Y,"codex.command.importExternalAgent":1}' }, ['seam:tap:messages']],
  ];
  for (const [what, over, items] of cases) {
    const r = deriveTapSeams(corpusOf(fx(over)));
    assert.equal(r.group, null, `${what}: no group at all`);
    assert.deepEqual(messagesOf(r), items, what);
  }
  // the message catalogs of the languages hold the id as data; they are not a command-messages table
  assert.equal(deriveTapSeams(corpusOf(fx({ 'webview/assets/fr-FR-dddddddddddd.js': 'export default{"codex.command.importExternalAgent":`Importer`}' }))).group.drafts.length, 3);
});

test('app-host: the AppHost hold follows the whole registerAppView statement (its .catch chain included); absent, duplicated, changed or not a statement is missing', () => {
  const main = '.vite/build/main-Zzzzzzzz.js';
  const ok = deriveAppHostSeam(fx());
  assert.deepEqual(ok.missing, []);
  const [d] = ok.group.drafts;
  assert.deepEqual([d.id, d.seam, d.op, d.file], ['seam-app-host', 'app-host', 'insert-after-once', main]);
  assert.match(d.find, /^n\?\.registerAppView\(e\.sender,i\)\.catch\(e=>\{.*\}\)$/);
  assert.match(d.text, /^;try\{globalThis\.__codexmods\?\.appHost\?\.\(r,e\.sender,i\)\}catch/);
  // without a .catch the statement ends at the call
  const bare = deriveAppHostSeam(fx({ [main]: FIXTURE[main].replace(/\.catch\(.*\}\)\}\)$/, '})') }));
  assert.equal(bare.group.drafts[0].find, 'n?.registerAppView(e.sender,i)');
  assert.deepEqual(messagesOf(deriveAppHostSeam(fx({ [main]: FIXTURE[main].replace('createAppHost', 'createAppHostX') }))), ['seam:app-host']);
  assert.deepEqual(messagesOf(deriveAppHostSeam(fx({ [main]: FIXTURE[main] + FIXTURE[main] }))), ['seam:app-host']);
  assert.deepEqual(messagesOf(deriveAppHostSeam(fx({ [main]: FIXTURE[main].replace('registerAppView(e.sender,i)', 'registerAppView(e.sender,i,1)') }))), ['seam:app-host']);
  assert.match(deriveAppHostSeam(fx({ [main]: FIXTURE[main].replace(/\}\)\}\)$/, '}),1)') })).missing[0].tried, /does not end the statement/);
  // two main bundles that both hold the anchors: no pick
  assert.match(deriveAppHostSeam(fx({ '.vite/build/main-Yyyyyyyy.js': FIXTURE[main] })).missing[0].tried, /2 main bundles/);
  assert.match(deriveAppHostSeam(synth({})).missing[0].tried, /0 main bundles/);
  // 22943's spelling (the host made inline): derived alone, and counted together with 21477's (one of each is two registrations)
  const inline = 'ipcMain.on(x,e=>{if(!A(e))return;let[t]=e.ports,r=d(e.sender),n=e_b(t,r?.createAppHost(e.sender));null!=r&&r.registerAppView(e.sender,n).catch(e=>{w(e)})})';
  const only = deriveAppHostSeam(fx({ [main]: inline }));
  assert.deepEqual([only.missing, only.group.drafts[0].op], [[], 'replace-once']);
  assert.match(deriveAppHostSeam(fx({ [main]: `${FIXTURE[main]};${inline}` })).missing[0].tried, /2 matches/, 'one of each: missing');
});

test('main-modules: a webpack main hands framework-main its module cache as data; a Vite main needs no seam; two runtimes are missing', () => {
  const entry = '.vite/build/early-bootstrap.js';
  const runtime = 'var a={1(e,t,n){t.q=[1]}},i={};function r(e){var t=i[e];if(void 0!==t)return t.exports;var n=i[e]={exports:{}};return a[e].call(n.exports,n,n.exports,r),n.exports}r.m=a,r.c=i,r.o=(e,t)=>1,r.f={},r.f.require=(e,t)=>{require("./"+r.u(e))};var o=r(1);module.exports=o';
  const wp = synth({ [entry]: runtime, '.vite/build/early-bootstrap-916-2f6483d5bfd826f1.js': 'exports.ids=[916]' });
  const ok = deriveMainModulesSeam(wp);
  assert.deepEqual(ok.missing, []);
  const [d] = ok.group.drafts;
  assert.deepEqual([d.id, d.seam, d.op, d.file, d.find], ['seam-main-modules', 'main-modules', 'replace-once', entry, 'r.m=a,r.c=i,']);
  // the patched runtime still runs, and writes the cache only into an existing __codexmods
  const ns = {}; const c1 = vm.createContext({ module: { exports: null }, require: () => ({}), __codexmods: ns }); vm.runInContext(`globalThis.__codexmods=__codexmods;${runtime.replace(d.find, d.text)}`, c1);
  assert.deepEqual(Object.keys(ns.mainModules), ['1']);
  assert.equal(JSON.stringify(c1.module.exports), '{"q":[1]}');
  const c2 = vm.createContext({ module: { exports: null }, require: () => ({}) }); vm.runInContext(runtime.replace(d.find, d.text), c2);
  assert.equal(c2.__codexmods, undefined);
  assert.equal(JSON.stringify(c2.module.exports), '{"q":[1]}');
  assert.deepEqual(deriveMainModulesSeam(fx()), { group: null, missing: [] });
  // the loader in any quote style
  assert.deepEqual(deriveMainModulesSeam(synth({ [entry]: runtime.replace('require("./"+r.u(e))', "require('./'+r.u(e))") })).missing, []);
  assert.deepEqual(deriveMainModulesSeam(synth({ [entry]: runtime.replace('require("./"+r.u(e))', 'require(`./${r.u(e)}`)') })).missing, [], 'a template loader');
  // the cache's two assignments either way round
  const swapped = deriveMainModulesSeam(synth({ [entry]: runtime.replace('r.m=a,r.c=i,', 'r.c=i,r.m=a,') }));
  assert.deepEqual([swapped.missing, swapped.group.drafts[0].find, /mainModules=i\)/.test(swapped.group.drafts[0].text)], [[], 'r.c=i,r.m=a,', true]);
  // a webpack runtime whose chunk loader or module cache is not found is a drift, not a build without one (port review 5, round 2)
  assert.deepEqual(messagesOf(deriveMainModulesSeam(synth({ [entry]: runtime.replace('require("./"+r.u(e))', 'r.u(e)') }))), ['seam:main-modules']);
  assert.deepEqual(messagesOf(deriveMainModulesSeam(synth({ [entry]: runtime.replace('r.m=a,r.c=i,', 'r.m=a;r.c=i;') }))), ['seam:main-modules']);
  assert.deepEqual(messagesOf(deriveMainModulesSeam(synth({ [entry]: runtime + ';' + runtime }))), ['seam:main-modules']);
});

// ------------------------------------------------------------------------------------------------ the text of each seam, run in a VM
const plain = (el) => (el === null || typeof el !== 'object' ? el : { t: String(el.$$typeof), type: el.type, key: el.key, ref: el.ref, props: JSON.stringify(el.props) });
const ctxWith = (hook) => { const c = vm.createContext({ Event: class { constructor(type, o) { this.type = type; this.defaultPrevented = false; Object.assign(this, o); } }, console }); if (hook !== undefined) c.__codexmods = hook; c.window = { dispatchEvent() { return false; } }; c.document = {}; c.th = {}; c.__meta = { resolve: (x) => x, url: 'app://-/x.js' }; return c; };

/** Evaluates the jsx-runtime wrapper (stock body and the patched body) and returns the exports it fills. */
function jsxRuntime(body, ns, ctx) { const exp = {}; vm.runInContext(`(function(${ns}){${body}})`, ctx)(exp); return exp; }
function jsxBodies(text, d) {
  const m = [...text.matchAll(JSX_RE)][0];
  const from = text.lastIndexOf('{', text.lastIndexOf('Symbol.for(`react.transitional.element`)', m.index)) + 1;
  return { ns: m.groups.ns, stock: text.slice(from, m.index + m[0].length - 1), patched: text.slice(from, m.index) + d.text.slice(0, -1) };
}
function checkJsxText(text, d, label) {
  const { ns, stock, patched } = jsxBodies(text, d);
  const props = { a: 1, children: ['x'] };
  const stockOut = (() => { const c = ctxWith(); const e = jsxRuntime(stock, ns, c); return { jsx: plain(e.jsx('div', props, 'k')), nokey: plain(e.jsx('span', { b: 2 })), keyInProps: plain(e.jsxs('p', { key: 'z', c: 3 })), frag: String(e.Fragment) }; })();
  // 1. the hook is absent (also: present but not a function): the stock result, and nothing is created on the global
  for (const hook of [undefined, {}, { jsx: 7 }]) {
    const c = ctxWith(hook); const e = jsxRuntime(patched, ns, c);
    assert.equal(e.jsx, e.jsxs, `${label}: jsx and jsxs stay one function`);
    assert.deepEqual({ jsx: plain(e.jsx('div', props, 'k')), nokey: plain(e.jsx('span', { b: 2 })), keyInProps: plain(e.jsxs('p', { key: 'z', c: 3 })), frag: String(e.Fragment) }, stockOut, `${label}: hook ${JSON.stringify(hook)}`);
    assert.equal(c.__codexmods === undefined ? undefined : c.__codexmods.faults, undefined);
  }
  // 2. the hook gets (factory, type, props, key) and may answer
  const seen = []; const mine = { mine: true };
  let c = ctxWith({ jsx: (factory, type, p, key) => { seen.push([typeof factory, type, p, key]); return type === 'b' ? mine : factory(type, p, key); }, faults: {} });
  let e = jsxRuntime(patched, ns, c);
  assert.equal(e.jsx('b', { q: 1 }, 'kk'), mine);
  assert.deepEqual(plain(e.jsx('div', props, 'k')), stockOut.jsx, `${label}: a hook that calls the factory gives the stock element`);
  assert.deepEqual(seen.map((s) => [s[0], s[1], s[3]]), [['function', 'b', 'kk'], ['function', 'div', 'k']]);
  // 3. a null or undefined answer means "not mine": the factory runs
  for (const answer of [null, undefined]) { c = ctxWith({ jsx: () => answer, faults: {} }); e = jsxRuntime(patched, ns, c); assert.deepEqual(plain(e.jsx('div', props, 'k')), stockOut.jsx); assert.deepEqual(c.__codexmods.faults, {}, 'not an error'); }
  // 4. a hook that throws: the stock element, one fault counted per throw; no faults object: no error
  c = ctxWith({ jsx: () => { throw new Error('boom'); }, faults: {} }); e = jsxRuntime(patched, ns, c);
  assert.deepEqual(plain(e.jsx('div', props, 'k')), stockOut.jsx); e.jsxs('p', {}); assert.equal(c.__codexmods.faults.jsx, 2);
  c = ctxWith({ jsx: () => { throw new Error('boom'); } }); e = jsxRuntime(patched, ns, c);
  assert.deepEqual(plain(e.jsx('div', props, 'k')), stockOut.jsx);
  c = ctxWith({ jsx: () => { throw new Error('boom'); }, faults: { jsx: 5 } }); e = jsxRuntime(patched, ns, c); e.jsx('i', {}); assert.equal(c.__codexmods.faults.jsx, 6);
}

test('jsx text (VM): hook absent = the stock element; a hook answers, passes (null/undefined) or throws (stock element, fault counted)', () => {
  const text = FIXTURE['webview/assets/app-shared-aaaaaaaaaaaa.js'];
  checkJsxText(text, deriveJsxSeam(corpusOf(fx())).group.drafts[0], 'synthetic');
});

function lazyFns(text, d) {
  const grab = (t) => { const m = [...t.matchAll(rx(String.raw`@name@=function\(@imp@,@deps@,@base@\)\{`))].find((x) => x[0].startsWith('nh=') || true); const p = t.indexOf('(', m.index); const b = t.indexOf('{', scanClose(t, p)); return t.slice(m.index + m.groups.name.length + 1, scanClose(t, b) + 1).replaceAll('import.meta', '__meta'); };
  const start = (t) => t.indexOf(text.match(LAZY_RE)[0].split('=')[0] + '=function');
  const cut = (t) => grab(t.slice(start(t)));
  return { stock: cut(text), patched: cut(applyOp(text, d)) };
}
async function checkLazyText(text, d, label) {
  const { stock, patched } = lazyFns(text, d);
  const load = (src, hook) => { const c = ctxWith(hook); return { c, nh: vm.runInContext(`(${src})`, c) }; };
  const mod = { X: 1 }; const importer = () => Promise.resolve(mod);
  // hook absent (or not a function): the module itself, through the same promise chain as the stock helper
  for (const hook of [undefined, {}, { lazy: 'no' }]) { const { nh } = load(patched, hook); assert.equal(await nh(importer), mod, `${label}: absent`); }
  assert.equal(await load(stock).nh(importer), mod);
  // a hook sees (importer source, module) and may replace the module
  const calls = []; const replacement = { X: 2 };
  let { nh } = load(patched, { lazy: (src, m) => { calls.push([src, m]); return replacement; }, faults: {} });
  let c;
  assert.equal(await nh(importer), replacement);
  assert.equal(calls.length, 1); assert.equal(calls[0][0], String(importer)); assert.equal(calls[0][1], mod);
  // null / undefined: unchanged, not a fault
  for (const answer of [undefined, null]) { ({ c, nh } = load(patched, { lazy: () => answer, faults: {} })); assert.equal(await nh(importer), mod); assert.deepEqual(c.__codexmods.faults, {}); }
  // a hook that throws: the module, one fault counted; without a faults object nothing else happens
  ({ c, nh } = load(patched, { lazy: () => { throw new Error('boom'); }, faults: {} })); assert.equal(await nh(importer), mod); assert.equal(await nh(importer), mod); assert.equal(c.__codexmods.faults.lazy, 2);
  ({ nh } = load(patched, { lazy: () => { throw new Error('boom'); } })); assert.equal(await nh(importer), mod);
  // the importer's failure takes the helper's own path (vite:preloadError, then the error), with or without a hook, and the hook is not asked
  const boom = new Error('chunk failed');
  await assert.rejects(load(stock).nh(() => Promise.reject(boom)), (e) => e === boom);
  let asked = 0; ({ nh } = load(patched, { lazy: () => { asked++; return replacement; } }));
  await assert.rejects(nh(() => Promise.reject(boom)), (e) => e === boom); assert.equal(asked, 0);
  // the helper's other duties are untouched: no dependency list, the promise still resolves from `e()`; a synchronous throw of the importer rejects, as in stock
  await assert.rejects(load(stock).nh(() => { throw boom; }), (e) => e === boom);
  await assert.rejects(load(patched, { lazy: () => replacement }).nh(() => { throw boom; }), (e) => e === boom);
}

test('lazy text (VM): hook absent = the stock helper; a hook may replace the module, pass, or throw (module unchanged, fault counted); failures take the stock path', async () => {
  const text = FIXTURE['webview/assets/app-shared-aaaaaaaaaaaa.js'];
  await checkLazyText(text, deriveLazySeam(corpusOf(fx())).group.drafts[0], 'synthetic');
});

/** Runs `code` (an expression) after `prelude`, in a fresh context. */
const runIn = (code, globals = {}) => vm.runInContext(code, vm.createContext({ ...globals }));
function checkTapText(drafts, label, { commandsLiteral = 'x:1}]', handlersLiteral = '()=>1]])' } = {}) {
  const [cmd, hnd, msg] = drafts;
  const evalSite = (d, tail, prelude, hooks) => runIn(`${prelude};(function(){var ${d.find.split('=')[0]};${(d.text ?? d.find)}${tail};return ${d.find.split('=')[0]}})()`, hooks === undefined ? {} : { __codexmods: hooks });
  // commands: [taps..., app entries]
  const cmdOf = (hooks, d) => JSON.stringify(evalSite(d, commandsLiteral, '', hooks));
  const stockCmd = JSON.stringify(evalSite({ find: cmd.find }, commandsLiteral, '', undefined));
  for (const hooks of [undefined, {}, { taps: {} }, { taps: { commands: 'nope' } }, { taps: { commands: null } }]) assert.equal(cmdOf(hooks, cmd), stockCmd, `${label}: commands, taps ${JSON.stringify(hooks)}`);
  assert.equal(cmdOf({ taps: { commands: [{ id: 'mine' }] } }, cmd), JSON.stringify([{ id: 'mine' }, ...JSON.parse(stockCmd)]), `${label}: tapped descriptors come first`);
  // handlers: [id, fn] pairs first, in a Map
  const hnOf = (hooks, d) => [...evalSite(d, handlersLiteral, '', hooks).keys()].join();
  const stockH = [...evalSite({ find: hnd.find }, handlersLiteral, '', undefined).keys()].join();
  for (const hooks of [undefined, {}, { taps: { handlers: 5 } }]) assert.equal(hnOf(hooks, hnd), stockH, `${label}: handlers, taps ${JSON.stringify(hooks)}`);
  assert.equal(hnOf({ taps: { handlers: [['mine', () => 0]] } }, hnd), `mine,${stockH}`);
  // messages: the tap's entries under the app's own (the app's win)
  const base = msg.find.match(/\{\.\.\.([\w$]+),/)[1];
  const msgOf = (hooks, d) => JSON.stringify(evalSite(d, '1}', `var ${base}={a:1,mine:'app'}`, hooks));
  const stockM = msgOf(undefined, { find: msg.find });
  for (const hooks of [undefined, {}, { taps: { messages: 'str' } }, { taps: { messages: null } }]) assert.equal(msgOf(hooks, msg), stockM, `${label}: messages, taps ${JSON.stringify(hooks)}`);
  assert.deepEqual(JSON.parse(msgOf({ taps: { messages: { tap: 'T', mine: 'tap' } } }, msg)), { tap: 'T', mine: 'app', a: 1, 'codex.command.importExternalAgent': 1 });
}

test('taps text (VM): the tap entries come first (messages: under the app\'s); absent, malformed or empty taps leave the tables as they are', () => {
  checkTapText(deriveTapSeams(corpusOf(fx())).group.drafts, 'synthetic');
});

/** Runs the statements of the app's window handler (`prefix` creates the AppHost and the AppView; `find` registers it) with and without the seam's `text` after them. */
function checkAppHostText({ prefix, find, text, names }, label) {
  const stockSrc = `(function(e,${names.d},${names.make},${names.p}){${prefix}${find}})`;
  const patchedSrc = `(function(e,${names.d},${names.make},${names.p}){${prefix}${find}${text}})`;
  const run = (src, hook, { ctx = true, registerThrows = false } = {}) => {
    const log = []; const host = { host: true }; const sender = { id: 1 };
    const c = vm.createContext({});
    if (hook !== undefined) c.__codexmods = hook;
    const fn = vm.runInContext(src, c);
    const windowCtx = () => ({ createAppHost: () => host, registerAppView: (sd, v) => { log.push(['register', sd === sender, v]); return registerThrows ? Promise.reject(new Error('x')) : Promise.resolve(); } });
    fn({ ports: ['port'], sender }, ctx ? windowCtx : () => null, (port, h) => { log.push(['make', port, h === host]); return 'view'; }, { r: () => ({ warning: (m) => log.push(['warning', m]) }) });
    return { log, host, sender };
  };
  const stockLog = run(stockSrc, undefined).log.map((l) => l[0]);
  assert.deepEqual(stockLog, ['make', 'register'], `${label}: the stock statements`);
  for (const hook of [undefined, {}, { appHost: 3 }]) assert.deepEqual(run(patchedSrc, hook).log.map((l) => l[0]), stockLog, `${label}: hook ${JSON.stringify(hook)}`);
  // the hook runs once, after registerAppView was called, with (host, sender, view)
  const calls = [];
  const r = run(patchedSrc, { appHost: (...a) => calls.push([...a]), faults: {} });
  assert.equal(calls.length, 1); assert.equal(calls[0][0], r.host); assert.equal(calls[0][1], r.sender); assert.equal(calls[0][2], 'view');
  assert.deepEqual(r.log.map((l) => l[0]), stockLog);
  // no window context: the host is undefined, and the app does what it did
  run(patchedSrc, { appHost: (...a) => calls.push([...a]) }, { ctx: false });
  assert.equal(calls.length, 2); assert.equal(calls[1][0], undefined);
  // a throwing hook is counted and the app goes on; without a faults object nothing else happens
  const faults = {}; const c = run(patchedSrc, { appHost: () => { throw new Error('boom'); }, faults });
  assert.equal(faults.appHost, 1); assert.deepEqual(c.log.map((l) => l[0]), stockLog);
  run(patchedSrc, { appHost: () => { throw new Error('boom'); } });
  assert.deepEqual(run(patchedSrc, { appHost: () => { throw new Error('boom'); }, faults: {} }, { registerThrows: true }).log.map((l) => l[0]), stockLog);
}

test('app-host text (VM): the hook is told (host, sender, view) once after registerAppView; absent or throwing, the app\'s own registration is unchanged', () => {
  const [d] = deriveAppHostSeam(fx()).group.drafts;
  checkAppHostText({ prefix: 'let[t]=e.ports,n=d(e.sender),r=n?.createAppHost(e.sender),i=O1e(t,r);', find: d.find, text: d.text, names: { d: 'd', make: 'O1e', p: 'p' } }, 'synthetic');
});

// ------------------------------------------------------------------------------------------------ the exposure block
test('exposureText: lazy cached getters on globalThis.__codexmods.exports; never overwrites the object, a getter is not called until read', () => {
  const text = exposureText([['a', '(init(),A)'], ['b', '{get v(){return B}}']]);
  assert.match(text, /^;\(\(\)=>\{/); assert.ok(text.endsWith('\n'));
  assert.deepEqual(exposedKeys(text), ['a', 'b']);
  const c = vm.createContext({ calls: 0 });
  vm.runInContext('var A=1,B=2;function init(){calls++}', c);
  vm.runInContext(text, c);
  assert.equal(c.calls, 0, 'nothing runs at definition');
  const ex = vm.runInContext('globalThis.__codexmods.exports', c);
  assert.equal(ex.a, 1); assert.equal(ex.a, 1); assert.equal(c.calls, 1, 'cached after the first read');
  assert.equal(ex.b, ex.b, 'one object per key');
  assert.deepEqual(Object.keys(ex), ['a', 'b']);
  // an existing __codexmods (the kernel) and exports object are extended, never replaced
  const k = vm.createContext({}); vm.runInContext('globalThis.__codexmods={jsx(){},exports:{keep:1}}', k); vm.runInContext(exposureText([['z', '9']]), k);
  assert.deepEqual(vm.runInContext('Object.keys(__codexmods).join()+"|"+Object.keys(__codexmods.exports).join()', k), 'jsx,exports|keep,z');
  // a getter that throws (an initialiser that is not ready) is retried on the next read
  const t = vm.createContext({ n: 0 }); vm.runInContext(exposureText([['f', '(()=>{if(n++<1)throw Error("early");return 5})()']]), t);
  assert.throws(() => vm.runInContext('__codexmods.exports.f', t), /early/); assert.equal(vm.runInContext('__codexmods.exports.f', t), 5);
});

test('the exposure runner: one block per chunk, keys found once; an absent, duplicated or changed anchor drops its key and says why, the others stand', () => {
  const chunk = (extra = '') => `var Zx;function iniA(){return(iniA=t((()=>{Zx={center:C1,left:L1,right:R1,main:M1,thread:T1,threadSummary:S1},Rq=cs(\`RouteScope\`,{key:k})})))()}var Zx,Rq;${extra}\n${MAP('app-initial-bbbbbbbbbbbb')}`;
  const files = (extra) => ({ 'webview/assets/app-initial-bbbbbbbbbbbb.js': chunk(extra) });
  const corpus = (extra) => corpusOf(synth(files(extra)));
  const r = deriveExposures(corpus());
  assert.deepEqual(r.exposures.map((e) => `${e.key}@${e.role}`).sort(), ['RouteScope@app-initial', 'headerSlots@app-initial']);
  assert.equal(r.groups.length, 1);
  const [d] = r.groups[0].drafts;
  assert.deepEqual([d.id, d.seam, d.op, d.find], ['seam-expose:app-initial', 'expose', 'insert-before-once', '//# sourceMappingURL=app-initial-bbbbbbbbbbbb.js.map']);
  assert.deepEqual(exposedKeys(d.text), ['headerSlots', 'RouteScope']);
  assert.match(d.text, /d\("headerSlots",\(\)=>\(iniA\(\),Zx\)\)/);
  assert.match(d.text, /d\("RouteScope",\(\)=>\(iniA\(\),Rq\)\)/, 'a module-level var assigned in a lazy initialiser is read after that initialiser');
  const miss = (extra, key) => deriveExposures(corpus(extra)).missing.filter((m) => m.item === `expose:${key}`);
  assert.equal(miss('', 'headerSlots').length, 0);
  assert.equal(miss('var Y2={center:C1,left:L1,right:R1,main:M1,thread:T1,threadSummary:S1};', 'headerSlots').length, 1, 'a second copy: no pick');
  assert.match(miss('var Y2={center:C1,left:L1,right:R1,main:M1,thread:T1,threadSummary:S1};', 'headerSlots')[0].tried, /2 matches/);
  assert.equal(miss('', 'toast').length, 1, 'absent');
  assert.match(miss('', 'toast')[0].tried, /0 matches/);
  const changed = corpusOf(synth({ 'webview/assets/app-initial-bbbbbbbbbbbb.js': chunk().replace('threadSummary:S1', 'threadSummaryX:S1') }));
  assert.equal(deriveExposures(changed).missing.filter((m) => m.item === 'expose:headerSlots').length, 1, 'changed');
  // the same object in two chunks is a second match as well
  const two = corpusOf(synth({ ...files(''), 'webview/assets/other-dddddddddddd.js': 'q={center:C1,left:L1,right:R1,main:M1,thread:T1,threadSummary:S1}' }));
  assert.equal(deriveExposures(two).missing.filter((m) => m.item === 'expose:headerSlots').length, 1);
  // a chunk without exactly one source-map comment cannot take the block: its keys are dropped with the reason
  const nomap = deriveExposures(corpusOf(synth({ 'webview/assets/app-initial-bbbbbbbbbbbb.js': chunk().replace(/\n\/\/#.*$/, '') })));
  assert.equal(nomap.groups.length, 0); assert.ok(nomap.missing.some((m) => /sourceMappingURL/.test(m.tried)));
  assert.equal(nomap.exposures.length, 0);
});

test('the whole run: groups are jsx, lazy, taps, menus, launcher, app-host and one exposure block per chunk; declarationFor lists what applied', () => {
  const src = fx();
  const r = deriveUiSeams(src);
  assert.deepEqual(r.groups.map((g) => g.id), ['jsx', 'lazy', 'taps', 'menus', 'file-menu', 'workspace-file-menu', 'tab-menu', 'launcher', 'markdown', 'app-host']);
  assert.ok(r.missing.every((m) => m.item.startsWith('expose:') || m.item.startsWith('seam:props:') || m.item === 'seam:markdown:text' || m.item === 'seam:page-route' || m.item === 'seam:destinations' || m.item === 'seam:rail-mode' || m.item === 'seam:copy' || m.item === 'seam:command' || m.item === 'seam:attach' || m.item === 'seam:review-action' || m.item === 'seam:pr-create' || m.item === 'seam:menu-command' || m.item === 'seam:sidebar-groups' || m.item === 'seam:tab-visible' || m.item === 'seam:responsive'), 'only the exposures, the identity props, the markdown renderer, the copy helper and the command dispatcher (this fixture has none of the app\'s objects) are missing');
  const sealed = sealTransforms(r.drafts, (p) => src.read(p));
  assert.deepEqual(declarationFor(sealed), { abi: 1, jsx: 'seam-jsx', lazy: 'seam-lazy', taps: ['seam-tap:commands', 'seam-tap:handlers', 'seam-tap:messages'], menuItems: 'seam-menu', menuKinds: { 'file-tree': 'seam-menu:file-tree', 'workspace-file': 'seam-menu:workspace-file', tab: 'seam-menu:tab' }, launcher: 'seam-launcher', markdown: ['seam-markdown:components', 'seam-markdown:directives'], appHost: 'seam-app-host' });
  assert.equal(declarationFor([{ id: 'x', seam: 'other', text: '' }]), null);
  assert.equal(sealed.filter(isUiSeam).length, 13);
  // applying them in order reproduces what the builder would do
  const out = applyAll(sealed, (p) => src.read(p));
  assert.equal(out.size, 5);
});

test('sealGroupsAfter: a group applies whole or not at all; a group whose site is gone after the transforms before it is dropped and reported, the others stand', () => {
  const src = fx();
  const r = deriveUiSeams(src);
  const initial = 'webview/assets/app-initial-bbbbbbbbbbbb.js';
  // a prior transform that removes the handlers site: the taps group (commands, handlers, messages) must go entirely
  const prior = sealTransforms([{ id: 'prior', seam: 'other', file: initial, op: 'replace-once', find: 'kbr=new Map([[`newTask`,', text: 'kbr=new Map([[`newTask2`,' }], (p) => src.read(p));
  const s = sealGroupsAfter(prior, r.groups, (p) => src.read(p));
  assert.deepEqual(s.dropped.map((d) => d.id), ['taps']);
  assert.match(s.dropped[0].why, /occurs 0 times/);
  assert.deepEqual(s.applied, ['jsx', 'lazy', 'menus', 'file-menu', 'workspace-file-menu', 'tab-menu', 'launcher', 'markdown', 'app-host']);
  assert.ok(!s.transforms.some((t) => t.id.startsWith('seam-tap')), 'not even the sites that still matched');
  // the chain continues from the prior transforms
  const priorAfter = prior.at(-1).sha256After;
  const onInitial = s.transforms.filter((t) => t.file === initial && isUiSeam(t));
  assert.deepEqual(onInitial.map((t) => t.id), ['seam-menu', 'seam-menu:workspace-file', 'seam-menu:tab', 'seam-launcher', 'seam-markdown:components', 'seam-markdown:directives'], 'the menus, launcher and markdown groups stand on the same chunk');
  assert.equal(onInitial[0].sha256Before, priorAfter, 'chained from the prior transform');
  assert.equal(s.transforms[0].sha256After, priorAfter);
  // the full-success path chains per file
  const ok = sealGroupsAfter([], r.groups, (p) => src.read(p));
  assert.deepEqual(ok.dropped, []);
  const byFile = new Map();
  for (const t of ok.transforms) { if (byFile.has(t.file)) assert.equal(t.sha256Before, byFile.get(t.file)); byFile.set(t.file, t.sha256After); }
  const viaApply = applyUiSeams(src, []);
  assert.deepEqual(viaApply.transforms.map((t) => t.sha256After), ok.transforms.map((t) => t.sha256After));
  assert.deepEqual(viaApply.hooks, declarationFor(ok.transforms));
});

// ------------------------------------------------------------------------------------------------ real substrates
// 20770 and 21477 are first-class targets: every group derives exactly once. 20156 (the design mirror) is only reported.
const SUBSTRATES = [
  { build: '20770', label: '26.1013.40934 (20770)', locate: () => locateStock({ bundleVersion: '20770', version: '26.1013.40934' }) },
  { build: '21477', label: '26.1016.62342 (21477)', locate: () => locateStock({ bundleVersion: '21477', version: '26.1016.62342' }) },
];
const MIRROR = join(REPO, '.tmp', 'mirror-20261012', 'asar');
const stem = fileStem;
const EXPECT = {
  'app-initial': ['appShell', 'headerSlots', 'tabRegistry', 'workspaceLayout', 'layoutSource', 'workspaceState', 'windowRegions', 'bottomHeight', 'ResizeDivider', 'responsive', 'panelMaths', 'launcherOrder', 'sidebarGroupState', 'SidebarSortable', 'sidebarFooter', 'navigationShell', 'panelControllers', 'modal', 'commandStack', 'commandRegistered', 'slashRegistry', 'slashHooks', 'routes', 'panelSlots', 'shellSignals', 'ComposerScope', 'RouteScope', 'ThreadScope', 'TextField', 'SettingsSection', 'SettingsPageFrame', 'NavItem', 'NavGroup', 'terminalManager', 'markdownComponents',
    'commandMenu', 'commandMenuItem', 'commandMenuSections', 'commandMenuState', 'commandMenuPages', 'commandMenuAsyncValue', 'ComposerControllerContext', 'threadFind', 'sidebarShowAll', 'sidebarOrderState', 'panelWidth', 'SidebarGroup', 'SidebarList', 'routeScopes', 'conversationTab', 'composerScopeValue', 'hostClient', 'pendingRequest'],
  'app-shared': ['atoms', 'AppScope', 'toast', 'bus', 'react', 'useScope', 'reactDom', 'Button', 'CodexButton', 'Switch', 'Menu', 'MenuParts', 'Dialog', 'DialogParts', 'SettingsRow', 'SettingsCard', 'Tooltip', 'Icon', 'KeysLabel', 'ScopeProvider'],
  'app-primary': ['composerBanners', 'ComposerDropdown', 'transcriptReveal', 'activityRow', 'PendingRequestPanel'],
  'agent-activity-item': ['dynamicToolRenderers'],
  'local-conversation-thread': ['threadView'],
};
// 20770's composer dropdown has another shape: that exposure does not derive there (its pickers use the app's Menu and Button, E3).
const ABSENT = { 20770: ['layoutSource', 'sidebarFooter', 'conversationTab', 'ComposerDropdown'] };   // 20770 draws its footer with another shape (no usage alert in its stack)
const expectFor = (build) => Object.fromEntries(Object.entries(EXPECT).map(([k, v]) => [k, v.filter((x) => !(ABSENT[build] ?? []).includes(x))]));
const cache = new Map();
function derived(s) {
  if (!cache.has(s.build)) { const stock = s.locate(); cache.set(s.build, stock ? { stock, ui: deriveUiSeams(stock.source) } : null); }
  return cache.get(s.build);
}

for (const s of SUBSTRATES) {
  const skip = () => (derived(s) ? false : `stock ${s.label} not available (CODEXMODS_STOCK_ASAR, .tmp/asar-${s.build}/ or the installed app)`);

  test(`real ${s.build}: every group derives exactly once (jsx, lazy, the three taps, the menu builder, the launcher where the build has it, the markdown builders, the AppHost hold, the exposures in four chunks)`, { skip: skip() }, () => {
    const { ui } = derived(s);
    // 20770's panels have no launcher filter of 21477's shape (E8.2b): that group is missing there, nothing else
    const launcher = s.build !== '20770';
    // nor a tab's visibility read of 21477's shape (layouts §4.1): the panels' kinds hide kind-wide there
    const tabVisible = s.build !== '20770';
    assert.deepEqual(ui.missing.map((m) => m.item), [...(launcher ? [] : ['seam:launcher']), ...(tabVisible ? [] : ['seam:tab-visible']), ...(ABSENT[s.build] ?? []).map((k) => `expose:${k}`)], 'nothing else is missing');
    assert.deepEqual(ui.groups.map((g) => g.id), ['jsx', 'lazy', 'taps', 'menus', 'file-menu', 'workspace-file-menu', 'tab-menu', ...(launcher ? ['launcher'] : []), 'markdown', 'markdown-text', 'sidebar-groups', ...(tabVisible ? ['tab-visible'] : []), 'responsive', 'page-route', 'destinations', 'rail-mode', 'copy', 'copy-origin', 'command', 'attach', 'review-action', 'pr-create', 'props:mcp-row', 'props:model-menu', 'props:branch-list', 'app-host', 'menu-command', 'seam-expose:agent-activity-item', 'seam-expose:app-initial', 'seam-expose:app-primary', 'seam-expose:app-shared', 'seam-expose:local-conversation-thread']);
    const roles = {}; for (const e of ui.exposures) (roles[e.role] ??= []).push(e.key);
    assert.deepEqual(Object.fromEntries(Object.entries(roles).map(([k, v]) => [k, [...v].sort()])), Object.fromEntries(Object.entries(expectFor(s.build)).map(([k, v]) => [k, [...v].sort()])));
    assert.deepEqual(ui.drafts.map((d) => d.id), ['seam-jsx', 'seam-lazy', 'seam-tap:commands', 'seam-tap:handlers', 'seam-tap:messages', 'seam-menu', 'seam-menu:file-tree', 'seam-menu:workspace-file', 'seam-menu:tab', ...(launcher ? ['seam-launcher'] : []), 'seam-markdown:components', 'seam-markdown:directives', 'seam-markdown:text', 'seam-sidebar-groups', ...(tabVisible ? ['seam-tab-visible'] : []), 'seam-responsive', 'seam-page-route', 'seam-destinations:head', 'seam-destinations', ...(s.build !== '22943' ? ['seam-destinations:memo'] : []), 'seam-rail-mode', 'seam-copy', 'seam-copy-origin:markdown', 'seam-copy-origin:folder', 'seam-copy-origin:link', 'seam-command', 'seam-attach', 'seam-review-action', 'seam-pr-create', 'seam-props:mcp-row', 'seam-props:mcp-row-plugin', 'seam-props:mcp-row-forward', 'seam-props:model-menu', 'seam-props:model-row', 'seam-props:branch-list', 'seam-app-host', 'seam-menu-command', 'seam-expose:agent-activity-item', 'seam-expose:app-initial', 'seam-expose:app-primary', 'seam-expose:app-shared', 'seam-expose:local-conversation-thread']);
    // every find occurs exactly once in its stock file, and no draft uses a minified name as an id or a chunk name as a role
    for (const d of ui.drafts) assert.ok(derived(s).stock.source.read(d.file).split(d.find).length === 2, `${d.id}: find occurs once`);
    assert.ok(ui.drafts.every((d) => !/[A-Za-z0-9_-]{8,12}\.js/.test(d.id)));
  });

  test(`real ${s.build}: the sealed seams apply after the stock transforms, hash-chained, and every patched chunk parses (renderer chunks as modules, main as a script)`, { skip: skip() }, () => {
    const { stock, ui } = derived(s);
    const sealed = sealTransforms(ui.drafts, (p) => stock.source.read(p));
    const out = applyAll(sealed, (p) => stock.source.read(p));
    assert.deepEqual([...out.keys()].map(stem).sort(), ['agent-activity-item', 'app-initial', 'app-primary', 'app-shared', 'base-file-tree', 'command-messages', 'git-action-new-branch-field', 'git-branch-switcher', 'local-conversation-thread', 'main', 'plugins-settings', 'thread-side-panel-tab-content'].sort());
    for (const [file, text] of out) {
      const r = spawnSync(process.execPath, ['--check', ...(file.startsWith('webview/') ? ['--input-type=module'] : [])], { input: text, encoding: 'utf8', maxBuffer: 1 << 26 });
      assert.equal(r.status, 0, `${file}: ${r.stderr.split('\n').slice(0, 4).join(' | ')}`);
    }
    for (const t of sealed) assert.ok(!/\$[&`'$0-9<]/.test(t.text), `${t.id}: no String.replace replacement pattern`);
    // exposures are appended before the source-map comment only: the chunk text before it is untouched
    for (const t of sealed.filter((x) => x.seam === 'expose')) assert.ok(out.get(t.file).includes(t.text + t.find), `${t.id}: the block sits right before the source-map comment`);
  });

  test(`real ${s.build}: a second copy of a site, or a changed site, is missing for its group (never a pick)`, { skip: skip() }, () => {
    const { stock, ui } = derived(s);
    const sites = Object.fromEntries(ui.drafts.map((d) => [d.id, d.file]));
    // a source of just the patched files (the derivers search by content, so the rest of the app changes nothing), and the same file once more under another name: every site in it occurs twice
    const files = new Set(ui.drafts.map((d) => d.file));
    const slim = { list: (p) => stock.source.list(p).filter((f) => files.has(f)), read: (p) => stock.source.read(p), size: (p) => stock.source.size(p) };
    const withCopy = (file) => {
      const copy = file.replace(/(-)([^-/]+\.js)$/, '$1copy$2');
      return { list: (p) => [...slim.list(p), ...(file.startsWith(p) ? [copy] : [])], read: (p) => slim.read(p === copy ? file : p), size: (p) => slim.size(p === copy ? file : p) };
    };
    for (const [what, derive, id] of [['jsx', (src) => deriveJsxSeam(corpusOf(src)), 'seam-jsx'], ['lazy', (src) => deriveLazySeam(corpusOf(src)), 'seam-lazy'], ['menus', (src) => deriveMenuSeam(corpusOf(src)), 'seam-menu'], ['app-host', deriveAppHostSeam, 'seam-app-host']]) {
      const r = derive(withCopy(sites[id]));
      assert.equal(r.group, null, what); assert.equal(r.missing.length, 1, what);
    }
    for (const id of ['seam-tap:commands', 'seam-tap:handlers', 'seam-tap:messages']) {
      const r = deriveTapSeams(corpusOf(withCopy(sites[id])));
      assert.equal(r.group, null, id); assert.ok(r.missing.length >= 1, id);
    }
    assert.equal(deriveExposures(corpusOf(withCopy(sites['seam-expose:app-primary']))).missing.some((m) => m.item === 'expose:composerBanners'), true, 'an exposure found in two chunks is not picked');
    // changed: the lazy helper loses its preload-error guard, a tap site loses its first entry's id
    const changed = (file, from, to) => ({ list: slim.list, size: slim.size, read: (p) => (p === file ? slim.read(p).split(from).join(to) : slim.read(p)) });
    assert.equal(deriveLazySeam(corpusOf(changed(sites['seam-lazy'], 'vite:preloadError', 'vite:preloadFail'))).group, null);
    assert.equal(deriveTapSeams(corpusOf(changed(sites['seam-tap:handlers'], 'new Map([[`newTask`,', 'new Map([[`newTask2`,'))).group, null);
    assert.equal(deriveAppHostSeam(changed(sites['seam-app-host'], 'createAppHost', 'createAppHostX')).group, null);
  });

  test(`real ${s.build}: the JSX factory wrapper, run in a VM: hook absent = stock; a throwing hook falls back and counts`, { skip: skip() }, () => {
    const { stock, ui } = derived(s);
    const d = ui.drafts.find((x) => x.id === 'seam-jsx');
    checkJsxText(stock.source.read(d.file), d, `real ${s.build}`);
  });

  test(`real ${s.build}: Vite's preload helper, run in a VM: hook absent = stock; a hook replaces, passes or throws (module kept, fault counted)`, { skip: skip() }, async () => {
    const { stock, ui } = derived(s);
    const d = ui.drafts.find((x) => x.id === 'seam-lazy');
    await checkLazyText(stock.source.read(d.file), d, `real ${s.build}`);
  });

  test(`real ${s.build}: the three command sites, run in a VM, with their real prefixes`, { skip: skip() }, () => {
    const { ui } = derived(s);
    checkTapText(ui.drafts.filter((d) => d.seam === 'tap'), `real ${s.build}`);
  });

  test(`real ${s.build}: the real AppHost statements, run in a VM with stubs for the app's own functions`, { skip: skip() }, () => {
    const { stock, ui } = derived(s);
    const d = ui.drafts.find((x) => x.id === 'seam-app-host');
    const text = stock.source.read(d.file);
    const at = text.indexOf(d.find);
    const prefix = text.slice(text.lastIndexOf('let[', at), at);               // `let[t]=e.ports,n=d(e.sender),r=n?.createAppHost(e.sender),i=make(t,r);`
    const g = /,(?<ctx>[$\w]+)=(?<d>[$\w]+)\(e\.sender\),[$\w]+=\k<ctx>\?\.createAppHost\(e\.sender\),[$\w]+=(?<make>[$\w]+)\(/.exec(prefix)?.groups;
    assert.ok(g, 'the statements keep their shape');
    const p = /\.catch\(e=>\{(?<p>[$\w]+)\.r\(\)\.warning\(/.exec(d.find)?.groups.p;
    assert.ok(p, 'the .catch handler logs through a logger');
    checkAppHostText({ prefix, find: d.find, text: d.text, names: { d: g.d, make: g.make, p } }, `real ${s.build}`);
  });

  test(`real ${s.build}: app-shared, app-initial, app-primary and agent-activity-item evaluated in a VM with the exposure blocks: every exposure resolves to the app's own object, with the members the API names`, { skip: skip() }, async (t) => {
    const { stock, ui } = derived(s);
    const sealed = sealTransforms(ui.drafts, (p) => stock.source.read(p));
    const out = applyAll(sealed, (p) => stock.source.read(p));
    const dir = mkdtempSync(join(tmpdir(), 'cm-seams-vm-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
    const chunk = (role) => [...out.keys()].find((f) => stem(f) === role);
    const paths = {};
    for (const [k, role] of [['shared', 'app-shared'], ['initial', 'app-initial'], ['primary', 'app-primary']]) { paths[k] = join(dir, `${role}.js`); writeFileSync(paths[k], out.get(chunk(role))); }
    // the lazy agent-activity-item chunk (the dynamic tool renderers) with the chunks it imports, stock
    paths.activity = join(dir, 'agent-activity-item.js'); writeFileSync(paths.activity, out.get(chunk('agent-activity-item')));
    paths.chunks = {};
    const assets = stock.source.list('webview/assets/');
    const importsOf = (text) => [...text.matchAll(/from"\.\/([^"]+)"/g)].map((m) => m[1]);
    const seen = new Set(['app-shared', 'app-initial', 'app-primary', 'rolldown-runtime', 'agent-activity-item']);
    for (const queue = importsOf(out.get(chunk('agent-activity-item'))); queue.length;) {
      const name = queue.pop(); const role = stem(name);
      if (seen.has(role)) continue;
      seen.add(role);
      const text = stock.source.read(assets.find((p) => p.endsWith(`/${name}`)));
      paths.chunks[role] = join(dir, `${role}.js`); writeFileSync(paths.chunks[role], text);
      queue.push(...importsOf(text));
    }
    paths.runtime = join(dir, 'rolldown-runtime.js'); writeFileSync(paths.runtime, stock.source.read(stock.source.list('webview/assets/').find((p) => /rolldown-runtime-[0-9a-f]{12}\.js$/.test(p))));
    writeFileSync(join(dir, 'files.json'), JSON.stringify(paths));
    const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', join(here, 'fixtures', 'vm-eval-seams.mjs'), join(dir, 'files.json')], { encoding: 'utf8', timeout: 110_000, maxBuffer: 1 << 26 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const o = JSON.parse(r.stdout.trim().split('\n').pop());
    for (const [k, v] of Object.entries(o)) assert.ok(!(v && v.threw), `${k} threw: ${v?.threw}`);
    // but the thread view's, whose lazy chunk is not evaluated here (it is defined once the app has loaded that chunk)
    assert.deepEqual([...o.keys].sort(), Object.values(expectFor(s.build)).flat().filter((k) => k !== 'threadView').sort(), 'every exposure is defined');
    assert.deepEqual(o.scopes, ['AppScope', 'ComposerScope', 'RouteScope', 'ThreadScope']);
    assert.deepEqual(o.toast.api, ['info', 'success', 'warning', 'danger', 'custom', 'closeAll']); assert.equal(o.toast.atom, 'object');
    assert.deepEqual(o.bus, { dispatchHostMessage: 'function', dispatchMessage: 'function', same: true });
    assert.match(o.react.version, /^19\./); assert.equal(o.react.useState, 'function'); assert.equal(o.react.cached, true, 'one object per key after the first read');
    assert.equal(o.useScope, 'function');
    for (const k of ['PaneHeaderRow', 'Root', 'Header', 'PageBanner', 'HeaderAction', 'HeaderContextMenuItem', 'HeaderToolbar', 'RightPanelTabListAfter', 'BottomPanelOutlet', 'DetailPanelOutlet']) assert.ok(o.appShell.members.includes(k), `appShell.${k}`);
    assert.deepEqual(Object.keys(o.headerSlots), ['center', 'left', 'right', 'main', 'thread', 'threadSummary']);
    for (const slot of Object.values(o.headerSlots)) assert.ok(['entries$', 'byId', 'ids$'].every((m) => slot.includes(m)), 'a header slot holds entries$, byId and ids$');
    assert.deepEqual(o.tabRegistry, { register: 'function', registry: 'Map' });
    assert.deepEqual(o.panelControllers, { openTab: 'function', right: 'function', bottom: 'function', distinct: true });
    assert.deepEqual(o.modal, { fns: ['function', 'function', 'function', 'function'], atom: 'object' });
    assert.equal(o.commandStack.stack, 'Map'); assert.equal(o.commandStack.defaults, 'Map');
    assert.deepEqual(o.commandStack.defaultNewTask, [true, true, false], 'the default handler table is the one that holds `newTask`');
    assert.deepEqual(o.commandStack.handled, [1, 'palette', true, false], 'a registered handler is called through run() and gone after its unregister');
    assert.deepEqual(o.commandStack.fns, ['function', 'function', 'function']);
    assert.deepEqual(o.commandRegistered, { useHandler: 'function', added: ['a'], item: true, removed: [], atom: 'object' });
    assert.deepEqual(o.slashRegistry, { atoms: ['object', 'object', 'object', 'object'], sortItems: 'function' });
    assert.deepEqual(o.slashHooks, { useComposerItem: 'function', useComposerItems: 'function', useAppItem: 'function', registerCore: 'function' });
    assert.equal(o.routes.array, true); assert.ok(o.routes.length >= 1);
    assert.deepEqual(o.panelSlots, { publish: 'function', pairs: 8, shape: true, inShell: 8 });
    assert.deepEqual(o.shellSignals, { Signal: 'function', header: ['component', 'children', 'desktopPlacement', 'contentFade', 'divider', 'separator'], pageBanner: ['component', 'signal'] });
    assert.equal(o.composerBanners.first, 'misalignment-policy'); assert.ok(o.composerBanners.count > 10);
    assert.deepEqual(o.composerBanners.candidate, { id: 'x', isEligible: true, isLoading: false, content: 'c' });
    assert.equal(o.composerBanners.selected, 'misalignment-policy'); assert.equal(o.composerBanners.List, 'function');
    assert.deepEqual(o.transcriptReveal, { atom: 'object', register: 'function' });
    assert.deepEqual(o.terminalManager, { renderers: 'Map', getOrCreateRenderer: 'function', same: true });
    assert.equal(o.markdownComponents, 'function');
    assert.deepEqual(o.dynamicToolRenderers, { list: true, shape: true, find: true });
    assert.equal(o.activityRow, 'function');
    assert.equal(o.commandMenu, true, 'cmdk\'s Command with its parts');
    assert.deepEqual([o.commandMenuItem, o.commandMenuSections, o.commandMenuState, o.commandMenuPages, o.KeysLabel], ['function', 'object', 'function', 'object', 'function']);
    assert.equal(o.commandMenuAsyncValue, 'command-menu-async-result:x', 'the app\'s async-result value');
    assert.equal(o.ComposerControllerContext, true, 'the context the app\'s own useComposerController reads');
    assert.equal(o.CodexButton, 'function', 'the Codex app\'s own button');
    assert.deepEqual(o.threadFind, { fns: true, atoms: ['open', 'query', 'domain', 'results', 'active'] }, 'the find bar\'s store');
    assert.deepEqual(o.sidebarShowAll, { set: 'function', atom: 'object' }, 'a project group\'s Show more');
    assert.deepEqual(o.panelWidth, { toRatio: 'function', persist: 'function', config: 'object', unified: 'object' }, 'the right panel\'s width');
    assert.deepEqual(o.workspaceLayout, { setFull: 'function', setPanel: 'function', activeTab: 'object', preference: 'object' }, 'the workspace\'s guarded layout setters');
    assert.deepEqual(o.windowRegions, { sidebarWidth: 'object', clampSidebar: 'function', setBottom: 'function' }, 'the window\'s live sidebar width and bottom panel setter');
    assert.deepEqual(o.bottomHeight, { clamp: 'function', range: [160, 400] }, 'the bottom panel\'s bounds: 160 px to half the main view');
    assert.equal(o.ResizeDivider, 'function', 'the app\'s resize divider');
    assert.deepEqual(o.responsive, { closeSide: 'function', restoreSide: 'function', setSidebar: 'function' }, 'the app\'s setters for space');
    assert.deepEqual(o.panelMaths, [648, 1000], 'the side panel\'s bounds at 1000 px: regular and full');
    assert.deepEqual(o.sidebarOrderState, { prefs: 'object', pinnedSortMode: 'object', projectOrder: 'object' }, 'what tells whether the user arranged a sidebar list');
    assert.deepEqual(o.navigationShell, { provider: true }, 'the frame\'s context (WL4a)');
    assert.deepEqual(o.hosted, { routeScopes: 'function', ScopeProvider: 'function', composerScopeValue: 'function', hostClient: 'function', composerValue: { kind: 'local', placement: 'main' } }, 'what hosts a chat in a mod\'s place (WL7)');
    if (!(ABSENT[s.build] ?? []).includes('conversationTab')) assert.equal(o.conversationTab, 'function', 'the app\'s lazy host of a second chat, with its prefetch');
    if (!(ABSENT[s.build] ?? []).includes('sidebarFooter')) assert.deepEqual(o.sidebarFooter, Object.fromEntries(['usageAlert', 'checklist', 'financeChecklist', 'announcement', 'updateBanner', 'invite', 'stack', 'row', 'account', 'update'].map((k) => [k, true])), 'the sidebar footer\'s components');
  });
}

// ------------------------------------------------------------------------------------------------ drift report
test('drift report: what derives on 20156 (the design mirror) and on the other builds; recorded, never failing', (t) => {
  const rows = [];
  const report = (label, src) => {
    const r = deriveUiSeams(src);
    rows.push(`${label}: groups ${r.groups.map((g) => g.id).join(',') || '-'}; exposures ${r.exposures.length}/${EXPOSURES.length}${r.missing.length ? `; missing ${r.missing.map((m) => m.item).join(',')}` : ''}`);
    return r;
  };
  for (const s of SUBSTRATES) { const d = derived(s); if (d) report(s.build, d.stock.source); }
  if (existsSync(MIRROR)) {
    const src = sourceFromDir(MIRROR);
    const r = report('20156', src);
    // the mirror holds the main process too, so the AppHost hold is reported as well; the modal controller lives in app-shared there
    t.diagnostic(`20156 modal in ${r.exposures.find((e) => e.key === 'modal')?.role ?? 'not found'}`);
  } else rows.push('20156: the design mirror is not present (.tmp/mirror-20261012/asar)');
  for (const row of rows) t.diagnostic(row);
  assert.ok(rows.length >= 1);
});

test('H7v: an identity props edit only inserts name:value props at a props object\'s boundary (a name, a path or !0), none twice nor one it has', async () => {
  const { propsOnly } = await import('./pack-tests.mjs');
  const t = (find, text, op = 'replace-once') => propsOnly({ op, find, text });
  assert.equal(t('(Ca,{name:n.name??t,statusLoading:', '(Ca,{serverKey:t,hostId:o,name:n.name??t,statusLoading:'), true);
  assert.equal(t(',label:x,control:S})', ',label:x,control:S,serverKey:e.serverKey,hostId:e.hostId})'), true);
  assert.equal(t('(\\u00248,{name:', '(\\u00248,{serverKey:\\u00248,name:'), true, 'a $ name as the seam spells it');
  assert.equal(t('(Ca,{name:', '(Ca,{x:alert(1),name:'), false, 'a call is not a prop value');
  assert.equal(t('(Ca,{name:', '(Cb,{name:'), false, 'a change, not an insertion');
  assert.equal(t('(Ca,{name:n,size:1})', '(Ca,{name:n,size:1,name:other})'), false, 'a key the object has');
  assert.equal(t('send("safe")', 'send("x:y,safe")'), false, 'not at a props object\'s boundary');
  assert.equal(t('(Ca,{name:n', '(Ca,{serverKey:k,name:n', 'insert-before-once'), false, 'only a replace');
  // review round 2: inside a string, a key the props have spelt quoted, a key not the seam's
  assert.equal(t('send("{safe}")', 'send("{serverKey:y,safe}")'), false, 'a brace in a string');
  assert.equal(t('(Row,{"hostId":n})', '(Row,{hostId:o,"hostId":n})'), false, 'a key the props have, quoted');
  assert.equal(t('(Row,{name:n})', '(Row,{key:other,name:n})'), false, 'React\'s key is not the seam\'s');
});

test('layouts WL1-3 review: windowRegions finds the sidebar\'s width and the bottom panel\'s setter by what they are, never a look-alike', () => {
  const e = EXPOSURES.find((x) => x.key === 'windowRegions');
  const inits = { ofVar: () => null, around: () => null, after: () => null };
  const app = ({ key = 'sidebar-width', panel = 'bottom' } = {}) =>
    `var NRt=\`${key}\`;function DRt(){return jRt(H_(NRt,340))}function ORt(e){U_(NRt,jRt(e))}function kRt(){return DRt()}function ARt(e){}function jRt(e,t=1/0,n=240){return e}`
    + 'MAn=sr(Q,DRt,{getServerSnapshot:kRt,onMount:ARt}),eO=sr(Ax,!1);function XD(e,t,n={}){e.set(eO,t)}'
    + `YB=_8r({panelId:\`right\`,getPanelOpenSignal:()=>nO,setPanelOpen:QQ}),XB=_8r({panelId:\`${panel}\`,getPanelOpenSignal:()=>eO,setPanelOpen:XD});`;
  assert.match(e.locate(app(), { inits })[0].expr, /^\{get sidebarWidth\(\)\{return MAn\},clampSidebar:jRt,setBottom:XD\}$/);
  assert.deepEqual(e.locate(app({ key: 'composer-width' }), { inits }), [], 'the width\'s functions read another key: not the sidebar\'s');
  assert.deepEqual(e.locate(app({ panel: 'left' }), { inits }), [], 'no bottom panel controller: no bottom setter');
});

test('layouts WL2-4a review: SidebarSortable is the container of the groups mapped from the section keys, never another sortable contents wrapper', () => {
  const e = EXPOSURES.find((x) => x.key === 'SidebarSortable');
  const inits = { ofVar: () => null, around: () => null, after: () => null };
  const groups = (dnd = 'Gt') => `let Zn=Vt.map(e=>e===\`teams\`?null:e===\`agents\`?(0,w2.jsx)(F8n,{sectionReorderDnd:${dnd}},e):e===\`chats\`?(0,w2.jsx)(C2.Fragment,{children:Xn},e):null),Qn=1;`;
  const box = (items = 'Gt', kids = 'Zn') => `let er=(0,w2.jsx)(\`div\`,{ref:y,className:\`contents\`,children:(0,w2.jsx)(kM,{items:${items}.sortableIds,strategy:PM,children:${kids}})});`;
  assert.deepEqual(e.locate(groups() + box(), { inits }).map((h) => h.expr), ['kM']);
  assert.deepEqual(e.locate(box(), { inits }), [], 'a sortable contents wrapper alone (another list): not the groups\'');
  assert.deepEqual(e.locate(groups() + box('Ht'), { inits }), [], 'another dnd\'s drag ids');
  assert.deepEqual(e.locate(groups() + box('Gt', 'Yn'), { inits }), [], 'other children');
});

test('layouts WL4 review: responsive finds the side panel\'s restore by its body, never a function that only reads the memory', () => {
  const e = EXPOSURES.find((x) => x.key === 'responsive');
  const close = 'function oAn(e){let t=e.get(tO);e.set(BAn,t?e.get(nO)?`tabs`:`detail`:`closed`),t&&ZD(e,!1,{closeReason:`window-resize`})}';
  const restore = 'function sAn(e){let t=e.get(BAn);t!=null&&(t===`tabs`?QD(e,!0):t===`detail`||e.get(RAn)?ZD(e,!0):e.set(BAn,null))}';
  const bar = 'function $kn(e,t,n={}){eAn(e,t,n)}function eAn(e,t,n){t||Xhe(),e.set(bAn,t),e.set(DAn,!1)}function tAn(e,t,n={}){e.set(EAn,!1),$kn(e,t,n)}';
  assert.match(e.locate(close + restore + bar)[0].expr, /restoreSide:sAn/);
  const decoy = 'function clearRemembered(e){let t=e.get(BAn);t!=null&&e.set(BAn,null)}';
  assert.deepEqual(e.locate(close + decoy + restore + bar), [], 'a function between them that only reads the memory: not the restore');
  const tabsOnly = 'function clearTabs(e){let t=e.get(BAn);t!=null&&t===`tabs`&&e.set(BAn,null)}';
  assert.deepEqual(e.locate(close + tabsOnly + restore + bar), [], 'one that checks the tabs and clears: its own body only, never the next function\'s');
});

test('layouts WL2-4a review: ResizeDivider is the app\'s divider by its whole destructure', () => {
  const e = EXPOSURES.find((x) => x.key === 'ResizeDivider');
  const keys = 'action:n,allowPointerOverflow:r,ariaLabel:i,currentSize:a,edge:o,defaultSize:s,extendIntoToolbar:c,getCurrentSize:l,hitArea:u,indicator:d,indicatorVisibility:f,keyboardStep:p,maximumSize:m,minimumSize:h,onResizeEnd:g,onResizingChange:_,renderInTopLayer:v,setSize:y';
  assert.deepEqual(e.locate(`function l5r(e){let t=(0,h5r.c)(57),{${keys}}=e,b=r;}`).map((h) => h.expr), ['l5r']);
  assert.deepEqual(e.locate(`function l5r(e){let t=(0,h5r.c)(57),{${keys.replace(',setSize:y', '')}}=e,b=r;}`), [], 'another component with fewer props');
});

test('layouts WL5a: the framework\'s page route goes in the app\'s tree beside `/codex-mobile`; an element with props or a second route is not it', () => {
  const corpusOf1 = (text) => ({ find: (n) => (text.includes(n) ? [{ file: 'a.js' }] : []), text: () => text });
  const hit = derivePageRouteSeam(corpusOf1(',(0,Q.jsx)(H,{path:`/x`,element:(0,Q.jsx)(a,{})}),(0,Q.jsx)(H,{path:`/codex-mobile`,element:(0,Q.jsx)(hM,{})}),(0,Q.jsx)(H,{path:`/y`})'));
  const [d] = hit.group.drafts;
  assert.equal(d.find, ',(0,Q.jsx)(H,{path:`/codex-mobile`,element:(0,Q.jsx)(hM,{})})');
  assert.equal(d.text, `${d.find},(0,Q.jsx)(H,{path:\`/codexmods/page/:mod/:page\`,element:(0,Q.jsx)(globalThis.__codexmods?.PageRoute??(()=>null),{})})`);
  assert.deepEqual(derivePageRouteSeam(corpusOf1(',(0,Q.jsx)(H,{path:`/other`})')).missing.map((m) => m.item), ['seam:page-route']);
  assert.deepEqual(derivePageRouteSeam(corpusOf1(',(0,Q.jsx)(H,{path:`/codex-mobile`,element:(0,Q.jsx)(hM,{a:1})})')).missing.map((m) => m.item), ['seam:page-route']);
});

const oneFile = (text) => ({ find: (n) => (text.includes(n) ? [{ file: 'a.js' }] : []), text: () => text });
const PROVIDER = 'function avn(e){let t=(0,c.c)(42),{children:n,desktopNavItemsEnabled:r}=e,i=1,m=si(),h=qc();';
const PROJECTS = 'x={onSelect:e=>{h(`/projects`,{state:e})},isCurrentDestination:m.pathname.startsWith(`/projects`)&&q};';
const SPLIT = 'let{primaryDestinations:L,standalonePrimaryDestinations:R,exploreDestinations:z}=Y(I,v===`disabled`,y,d);';

test('layouts WL5b: the destinations go in before the provider\'s split; the provider follows them; a memo block around the list asks for their revision', () => {
  const plain = deriveDestinationsSeam(oneFile(`${PROVIDER}${PROJECTS}${SPLIT}`));
  const by = Object.fromEntries(plain.group.drafts.map((d) => [d.id, d]));
  assert.deepEqual(Object.keys(by), ['seam-destinations:head', 'seam-destinations']);
  assert.equal(by['seam-destinations:head'].text, '{children:n,desktopNavItemsEnabled:r}=e,__cmDest=globalThis.__codexmods?.useDestinationsRev?.(),');
  assert.equal(by['seam-destinations'].text, `I=globalThis.__codexmods?.destinations?.(I,{location:m,navigate:h})??I;${by['seam-destinations'].find}`);
  const memo = deriveDestinationsSeam(oneFile(`${PROVIDER}let P,F;if(t[4]!==k||t[5]!==y){${PROJECTS}${SPLIT}}else I=t[29]`));
  const m = Object.fromEntries(memo.group.drafts.map((d) => [d.id, d]));
  assert.equal(m['seam-destinations:memo'].find, ';if(t[4]!==k||');
  assert.equal(m['seam-destinations:memo'].text, ';if(t.__cmDestRev!==globalThis.__codexmods?.destinationsRev?.()||t[4]!==k||');
  assert.match(m['seam-destinations'].text, /^t\.__cmDestRev=globalThis\.__codexmods\?\.destinationsRev\?\.\(\);I=/);
  assert.deepEqual(deriveDestinationsSeam(oneFile(SPLIT)).missing.map((x) => x.item), ['seam:destinations'], 'no provider before it');
  // another memo block before the list's own, closed before the split, is not the list's: the seam leaves it alone
  const other = deriveDestinationsSeam(oneFile(`${PROVIDER}let a;if(t[1]!==q||t[2]!==w){a=1}else a=t[3];${PROJECTS}${SPLIT}`));
  assert.deepEqual(other.group.drafts.map((d) => d.id), ['seam-destinations:head', 'seam-destinations'], 'no memo draft');
  // a head from another component, a function between it and the split: not the provider's
  assert.deepEqual(deriveDestinationsSeam(oneFile(`${PROVIDER}function z(){}${PROJECTS}${SPLIT}`)).missing.map((x) => x.item), ['seam:destinations']);
  assert.deepEqual(deriveDestinationsSeam(oneFile(PROVIDER)).missing.map((x) => x.item), ['seam:destinations'], 'no split');
});

test('layouts WL5c: the rail\'s mode asks last, so the app\'s earlier returns stay the app\'s', () => {
  const ok = deriveRailModeSeam(oneFile('return s||D(e)==null&&C(r)?`rail-with-contextual-sidebar`:`rail-only`}'));
  const [d] = ok.group.drafts;
  assert.equal(d.text, '||D(e)==null&&C(r)||globalThis.__codexmods?.railMode?.(e)===!0?`rail-with-contextual-sidebar`:`rail-only`}');
  assert.deepEqual(deriveRailModeSeam(oneFile('return s?`rail-with-contextual-sidebar`:`rail-only`}')).missing.map((x) => x.item), ['seam:rail-mode']);
});
