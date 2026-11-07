// The census (census.mjs, integration.md §9) and the committed build facts of the 20770 and 21477 packs. Tests marked "stock" read the stock app's
// code of exactly the build in their title (read-only, never launched): CODEXMODS_STOCK_ASAR, the extraction .tmp/asar-<bundle>/, or the installed
// app (stock.mjs); they skip when none of them is that build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { census } from './census.mjs';
import { locateStock } from './stock.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const BUILDS = [
  { bundle: '20770', version: '26.1013.40934', dir: '26.1013.40934-20770' },
  { bundle: '21477', version: '26.1016.62342', dir: '26.1016.62342-21477' },
  { bundle: '22943', version: '26.1027.30824', dir: '26.1027.30824-22943' },
];
const FAMILIES = ['bus.fromView', 'bus.toView', 'bus.fetchHandlers', 'ipc.channels', 'state.globalKeys', 'state.persistedAtoms', 'state.sharedObjects',
  'commands.ids', 'settings.slugs', 'panel.tabKinds', 'items.types', 'apphost.services', 'routes.paths', 'i18n.ids', 'dom.dataAppAttrs',
  'protocol.schema', 'protocol.wireOnly', 'choke.jsx', 'choke.lazy', 'choke.react', 'choke.taps', 'choke.menus', 'choke.appHost', 'ui.exposures', 'lazy.addresses',
  'bindings.sites'];
const ADDRESSES = JSON.parse(readFileSync(join(here, '..', '..', 'framework', 'renderer', 'present', 'addresses.json'), 'utf8'));


for (const B of BUILDS) defineCensusTests(B);

function defineCensusTests({ bundle, version, dir }) {
  const PACK = join(here, '..', dir);
  const SCHEMA = join(here, '..', '..', 'contracts', 'upstream', dir);
  const facts = JSON.parse(readFileSync(join(PACK, 'build-facts.json'), 'utf8'));
  const located = locateStock({ bundleVersion: bundle, version });
  /** The census input: the source of the located stock (asar paths, whichever form the stock has). */
  const stock = located && { list: () => located.source.list(''), read: (p) => located.source.read(p), size: (p) => located.source.size(p) };
  const noStock = stock ? false : `stock ChatGPT ${version} (${bundle}) not available (CODEXMODS_STOCK_ASAR, .tmp/asar-${bundle}/ or the installed app)`;
  const has = (id, v) => (facts.families[id].values ?? []).includes(v);
  const run = (src, only) => census(src, join(SCHEMA, 'schema'), join(SCHEMA, 'schema-experimental'), { only });
  const edit = (from, to) => ({ list: () => stock.list(), size: (p) => stock.size(p), read: (p) => { const t = stock.read(p); return t.includes(from) ? t.split(from).join(to) : t; } });

  test(`${bundle} build facts: every family anchored exactly, with its count and the digest of its values`, () => {
    assert.deepEqual(facts.build, { name: 'openai-codex-electron', version, buildNumber: bundle });
    assert.deepEqual(Object.keys(facts.families), FAMILIES);
    for (const [id, f] of Object.entries(facts.families)) {
      assert.equal(f.status, 'ok', id);
      // a family whose vocabulary the build no longer has says so (`retired`) and counts none (22943's shared objects)
      assert.ok(Number.isInteger(f.count) && (f.count > 0 || f.retired === true), id);
      assert.match(f.digestSha256, /^[0-9a-f]{64}$/, id);
      assert.ok(Array.isArray(f.files) && f.files.every((r) => !/-[0-9a-f]{8,}\.js/.test(r)), `${id}: files are roles, not hashed chunk names`);
    }
    assert.equal(facts.summary.failed, 0);
  });

  if (bundle === '20770') {
    test('20770 build facts: what the native proofs settled on 20770 is in them', () => {
      for (const v of ['automation-create', 'set-setting', 'set-global-state', 'worktree-create-managed', 'codex-agents-md-save']) assert.ok(has('bus.fetchHandlers', v), v);
      assert.equal(facts.families['bus.fetchHandlers'].count, 131);
      assert.ok(!has('bus.fromView', 'set-global-state'), 'set-global-state is a fetch handler, not a bus message (batch 2, B1)');
      assert.ok(has('bus.fromView', 'show-settings') && !has('bus.toView', 'show-settings'), 'show-settings goes from the window to main (batch 2, A12)');
      for (const v of ['projects', 'pinnedThreads', 'settings', 'terminal', 'threadReadState']) assert.ok(has('apphost.services', v), v);
      assert.equal(facts.families['settings.slugs'].count, 52);
      assert.equal(facts.families['apphost.services'].count, 141);
      assert.deepEqual(facts.families['choke.react'].values, ['19.2.7']);
      for (const v of ['review', 'terminal', 'unrestored-route']) assert.ok(has('panel.tabKinds', v), v);
      for (const v of ['diff_comments', 'diff_comments_from_model', 'diff_comment_drafts']) assert.ok(has('state.sharedObjects', v), v);
    });
  } else if (bundle === '22943') {
    test('22943 build facts: the fetch handler map keeps one key, the shared objects are gone, the AppHost services grew (against 21477)', () => {
      const f = facts.families;
      // the main process was re-bundled (webpack) and respelled; the vocabularies are the same kinds, found in their new chunks
      assert.deepEqual(f['bus.fetchHandlers'].values, ['set-remote-wsl-connections-enabled']);
      assert.equal(f['state.sharedObjects'].retired, true);
      assert.deepEqual(f['state.sharedObjects'].values, []);
      assert.equal(f['apphost.services'].count, 190);
      for (const v of ['projects', 'pinnedThreads', 'settings', 'terminal', 'threadReadState', 'workspaceRoots', 'gitRepository', 'queryCache', 'remoteConnections']) assert.ok(has('apphost.services', v), v);
      assert.equal(f['bus.fromView'].count, 147);
      assert.ok(has('bus.fromView', 'show-settings') && !has('bus.toView', 'show-settings'));
      assert.equal(f['settings.slugs'].count, 53);
      assert.deepEqual(f['choke.react'].values, ['19.2.7']);
      for (const v of ['review', 'terminal', 'unrestored-route']) assert.ok(has('panel.tabKinds', v), v);
    });
  } else {
    test('21477 build facts: the app moved most main-process fetch handlers and the shared objects to the AppHost services (against 20770)', () => {
      const f = facts.families;
      // the fetch handler map shrank from 131 to 37 keys: the global state, settings, files and remote-control handlers stay, the rest is gone from it
      assert.equal(f['bus.fetchHandlers'].count, 37);
      for (const v of ['get-global-state', 'set-global-state', 'get-setting', 'set-setting', 'settings-read', 'settings-write', 'read-file']) assert.ok(has('bus.fetchHandlers', v), v);
      for (const v of ['automation-create', 'worktree-create-managed', 'codex-agents-md-save', 'list-pinned-threads', 'workspace-root-options']) assert.ok(!has('bus.fetchHandlers', v), `${v} left the fetch handler map`);
      // ... and the AppHost services took them over (141 -> 167, 29 new)
      assert.equal(f['apphost.services'].count, 167);
      for (const v of ['projects', 'pinnedThreads', 'settings', 'terminal', 'threadReadState', 'workspaceRoots', 'gitRepository', 'queryCache', 'remoteConnections']) assert.ok(has('apphost.services', v), v);
      // the per-window shared objects of 20770 (diff comments, pending worktrees, host config, statsig) are gone: five keys remain, all remote control
      assert.equal(f['state.sharedObjects'].count, 5);
      assert.ok(f['state.sharedObjects'].values.every((v) => v.startsWith('local_remote_control_') || v === 'remote_control_connections_state'));
      assert.ok(!has('bus.fromView', 'set-global-state'));
      assert.ok(has('bus.fromView', 'show-settings') && !has('bus.toView', 'show-settings'));
      assert.ok(!has('bus.fromView', 'pending-worktree-create'), 'the pending worktree messages are gone');
      assert.equal(f['settings.slugs'].count, 53);
      assert.deepEqual(f['choke.react'].values, ['19.2.7']);
      for (const v of ['review', 'terminal', 'unrestored-route']) assert.ok(has('panel.tabKinds', v), v);
      assert.ok(!has('panel.tabKinds', 'pull-request-fix-automation'));
    });
  }

  test(`${bundle} build facts: the C5 families name the seams' sites, the exposures by chunk role, and the lazy addresses`, () => {
    const f = facts.families;
    // 22943 moved the command table to app-shared, the thread menu to app-primary, and the AppHost registration into a webpack chunk
    const late = bundle === '22943';
    assert.deepEqual(f['choke.taps'].values, [`commands@renderer:${late ? 'app-shared' : 'app-initial'}`, 'handlers@renderer:app-initial', 'messages@renderer:command-messages']);
    assert.deepEqual(f['choke.menus'].values, [`menus@renderer:${late ? 'app-primary' : 'app-initial'}`]);
    assert.deepEqual(f['choke.appHost'].values, [late ? 'early-bootstrap-916' : 'main']);
    assert.equal(f['choke.appHost'].files[0], late ? 'main-process:early-bootstrap-916' : 'main-process:main');
    // E8.5 added the palette's seven exposures; layouts WL3 the workspace's layout setters and the window's regions, WL2 the sidebar's order state, its footer, its groups' state and sortable container, the panels' atoms and launcher order, WL4a the frame's context; 20770's composer dropdown and footer have other shapes (systems.md E3: its pickers use the app's Menu and Button there).
    assert.equal(f['ui.exposures'].count, bundle === '20770' ? 76 : 80);
    assert.deepEqual(Object.keys(f['ui.exposures'].missing).sort(), bundle === '20770' ? ['ComposerDropdown', 'conversationTab', 'layoutSource', 'sidebarFooter'] : [], `every other exposure is found exactly once on ${bundle}`);
    assert.deepEqual(Object.fromEntries(['modal', 'commandRegistered', 'toast', 'composerBanners', 'RouteScope', 'AppScope'].map((k) => [k, f['ui.exposures'].values.find((v) => v.startsWith(`${k}@`))])),
      { modal: 'modal@app-initial', commandRegistered: 'commandRegistered@app-initial', toast: 'toast@app-shared', composerBanners: 'composerBanners@app-primary', RouteScope: 'RouteScope@app-initial', AppScope: 'AppScope@app-shared' });
    assert.ok(f['lazy.addresses'].count > 1000);
    for (const v of ['command-menu-dialog:CommandMenuDialog', 'delete-thread-dialog:DeleteThreadDialog']) assert.ok(f['lazy.addresses'].values.includes(v), v);
    assert.ok(f['lazy.addresses'].values.every((v) => /^[^:]+:[\w$]+$/.test(v) && !/-[0-9a-f]{12}$/.test(v.split(':')[0])), 'chunk names without their content hash');
  });

  test(`${bundle} build facts: the static binding census finds every binding addressed by keys, the sidebar row, the run location bar and the home composer through their props' objects (E4, E8.3b, E8.9)`, () => {
    const b = facts.families['bindings.sites'];
    // What a build does not have: 20770 has no all-files pane (its tree's pane passes other props; E7.4) and its title bar takes other
    // props (E8.9: the title bar's entries are 21477's). 22943's drift (a prop gained or lost) is in the addresses' optional keys.
    const absent = bundle === '20770' ? ['files.pane', 'window.titlebar'] : [];
    const keyed = ADDRESSES.bindings.filter((x) => Array.isArray(x.keys) && x.keys.length && !absent.includes(x.id)).map((x) => x.id).sort();
    assert.deepEqual(b.values, keyed, 'all found');
    assert.deepEqual(b.notFound, absent);
    // these components' props are built apart and spread into the element (the composer's run location bar: E8.3b); the home page's
    // composer's (E8.9) also match the composer's own destructuring, which takes them
    // an agent's background terminal tab's body is given its tab's props spread too (H7x review 1)
    // (22943 builds the sidebar list's props apart too)
    const spread = ['sidebar.item', 'composer.runLocation', 'new.thread.composer', 'terminal.background', ...(bundle === '22943' ? ['sidebar.list'] : [])];
    for (const id of spread) assert.deepEqual(b.sites[id].jsx, 0, `${id}: its props are built apart and spread into the element`);
    for (const id of spread) assert.ok(b.sites[id].objects >= 1, id);
    if (bundle !== '22943') for (const id of spread) assert.equal(b.sites[id].objects, id === 'new.thread.composer' ? 2 : 1, id);
    for (const id of keyed.filter((x) => !spread.includes(x))) assert.ok(b.sites[id].jsx >= 1, id);
    assert.match(b.addressesSha256, /^[0-9a-f]{64}$/);
    // Every method has a fingerprint (params and result); 20770 and 21477 differ in one (thread/realtime/start's params changed); 22943
    // adds seven methods and changes 32 others' params or results (additive fields: the thread item's timings, account sessions, ...)
    const fp = facts.families['protocol.schema'].fingerprints;
    assert.equal(Object.keys(fp).length, facts.families['protocol.schema'].count);
    assert.ok(Object.values(fp).every((v) => /^[0-9a-f]{16}$/.test(v)));
    const printsOf = (b) => JSON.parse(readFileSync(join(here, '..', BUILDS.find((x) => x.bundle === b).dir, 'build-facts.json'), 'utf8')).families['protocol.schema'].fingerprints;
    const other = printsOf(bundle === '20770' ? '21477' : bundle === '21477' ? '20770' : '21477');
    const changed = Object.keys(fp).filter((k) => fp[k] !== other[k]);
    if (bundle !== '22943') assert.deepEqual(changed, ['ClientRequest:thread/realtime/start']);
    else {
      const added = changed.filter((k) => !(k in other));
      assert.deepEqual(added, ['ClientRequest:account/gcp/setup', 'ClientRequest:accountSession/list', 'ClientRequest:accountSession/switch', 'ClientRequest:feedback/save', 'ClientRequest:thread/memory/read', 'ClientRequest:thread/sample', 'ClientRequest:thread/sample/cancel']);
      assert.equal(changed.length - added.length, 32);
      for (const k of ['ClientRequest:thread/start', 'ClientRequest:turn/start', 'ServerNotification:item/completed']) assert.ok(changed.includes(k), k);
      assert.deepEqual(Object.keys(other).filter((k) => !(k in fp)), [], 'no method removed');
    }
  });

  test(`stock ${bundle}: the census of the stock app reproduces the committed build facts`, { skip: noStock }, () => {
    const now = run(stock);
    assert.equal(now.summary.failed, 0);
    for (const id of FAMILIES) assert.deepEqual([now.families[id].count, now.families[id].digestSha256], [facts.families[id].count, facts.families[id].digestSha256], id);
  });

  test(`stock ${bundle}: a drifted anchor fails its family and every family that depends on it, loudly and without values`, { skip: noStock }, () => {
    const ANCHOR = '[{id:`newTask`,titleIntlId:';
    const drifted = {
      list: () => stock.list(),
      size: (p) => stock.size(p),
      read: (p) => { const t = stock.read(p); return t.includes(ANCHOR) ? t.replace(ANCHOR, '[{id:`newTask2`,titleIntlId:') : t; },
    };
    const now = run(drifted);
    const failed = Object.entries(now.families).filter(([, f]) => f.status === 'fail');
    assert.ok(failed.some(([id]) => id === 'commands.ids'), 'the command table family fails');
    for (const [id, f] of failed) { assert.equal(f.values, undefined, `${id} emits no values`); assert.match(f.error, /\S/, id); }
    assert.ok(now.families['protocol.schema'].status === 'ok', 'families that do not depend on the drifted file still run');
  });

  test(`stock ${bundle}: the C5 families fail loudly when their sites drift (a tap, the AppHost hold, the lazy helper) and degrade key by key for the exposures`, { skip: noStock }, () => {
    const taps = run(edit('new Map([[`newTask`,', 'new Map([[`newTask2`,'), ['choke.taps']);
    assert.equal(taps.families['choke.taps'].status, 'fail'); assert.match(taps.families['choke.taps'].error, /handler table.*matched 0 times/);
    const host = run(edit('registerAppView(', 'registerAppViewX('), ['choke.appHost']);
    assert.equal(host.families['choke.appHost'].status, 'fail');
    const lazy = run(edit('vite:preloadError', 'vite:preloadFail'), ['choke.lazy']);
    assert.equal(lazy.families['choke.lazy'].status, 'fail'); assert.match(lazy.families['choke.lazy'].error, /preloadError/);
    const menus = run(edit('showForkInSidebar:', 'showForkHere:'), ['choke.menus']);
    assert.equal(menus.families['choke.menus'].status, 'fail'); assert.match(menus.families['choke.menus'].error, /matched 0 times/);
    // an anchor shared by two exposures is gone: the family still reports the others, and says which two and why
    const some = run(edit('HeaderContextMenuItem:', 'HeaderContextMenuItemX:'), ['ui.exposures']).families['ui.exposures'];
    assert.equal(some.status, 'ok'); assert.equal(some.count, bundle === '20770' ? 74 : 78);
    assert.deepEqual(Object.keys(some.missing).sort().filter((k) => k !== 'ComposerDropdown' && k !== 'sidebarFooter' && k !== 'layoutSource' && k !== 'conversationTab'), ['appShell', 'panelSlots']);
    assert.ok(!some.values.some((v) => v.startsWith('appShell@')));
    // none left (no chunk can take a block: their source-map comments are gone): the family fails
    const none = run({ list: () => stock.list(), size: (p) => stock.size(p), read: (p) => (p.startsWith('webview/assets/') ? stock.read(p).replaceAll('//# sourceMappingURL=', '//# sourceMapX=') : stock.read(p)) }, ['ui.exposures']);
    assert.equal(none.families['ui.exposures'].status, 'fail');
  });

  test(`stock ${bundle}: wire-only methods: an MCP name is left out on weak evidence only; the AppHost services fail on a spread they cannot read (port review 3, 4)`, { skip: noStock }, () => {
    const DISPATCH = 'not implemented in the current Electron process';
    const w = run(edit(DISPATCH, `${DISPATCH} x=z.object({method:z.literal("thread/mcpOnly")}) y={method:"thread/mcpOnly"} sendAppServerRequest("thread/portProbe",1) sendAppServerRequest("thread/mcpSure",1) z.literal; m={method:z.literal("thread/mcpSure")} sendRequest("thread/weakProbe",{}) "tools/call"`), ['protocol.wireOnly']).families['protocol.wireOnly'];
    assert.equal(w.status, 'ok');
    assert.ok(w.values.includes('thread/portProbe'), 'an app-server call counts');
    assert.ok(w.values.includes('thread/mcpSure'), 'an app-server call counts even for a name an MCP schema declares');
    assert.ok(w.values.includes('thread/weakProbe'), 'a weak name near "tools/call" but in no MCP schema counts (round 2)');
    assert.ok(!w.values.includes('thread/mcpOnly') && w.mcpMethodNames.includes('thread/mcpOnly'), 'a weak name an MCP schema declares is MCP\'s');
    // a spread of the host class's own services that resolves to nothing readable
    const broken = run({ list: () => stock.list(), size: (p) => stock.size(p), read: (p) => { const t = stock.read(p); return t.includes('get services(){return this.#') ? t.replace(new RegExp(`(get services\\(\\)\\{return this\\.#[\\w$]+\\}constructor\\(\\{[^}]*?\\.\\.\\.([\\w$]+)\\}\\)\\{super\\(\\),this\\.#[\\w$]+=\\{\\.\\.\\.\\2,)`), '$1...notDefinedAnywhere(),') : t; } }, ['apphost.services']).families['apphost.services'];
    assert.equal(broken.status, 'fail');
    assert.match(broken.error, /host class's services cannot be read/);
  });

  test(`stock ${bundle}: the fetch handler map is found by the dispatcher's failure text, and every drift of that site fails closed`, { skip: noStock }, () => {
    const DISPATCH = 'not implemented in the current Electron process';
    const fetchFamily = (src) => run(src, ['bus.fetchHandlers']).families['bus.fetchHandlers'];
    const good = fetchFamily(stock);
    assert.equal(good.status, 'ok');
    assert.deepEqual([good.count, good.digestSha256], [facts.families['bus.fetchHandlers'].count, facts.families['bus.fetchHandlers'].digestSha256]);
    assert.deepEqual(good.anchorHits, { [DISPATCH]: 1, 'handlers={ field': 1 });
    const bad = (what, f, re) => { assert.equal(f.status, 'fail', what); assert.equal(f.values, undefined, `${what}: no values`); assert.match(f.error, re, what); };
    bad('the dispatcher text is gone', fetchFamily(edit(DISPATCH, 'is not implemented here')), /dispatcher.*matched 0 times/);
    bad('the dispatcher text occurs twice', fetchFamily(edit(DISPATCH, `${DISPATCH}; ${DISPATCH}`)), /dispatcher.*matched 2 times/);
    bad('the lookup is no longer this.handlers[...]', fetchFamily(edit('this.handlers[', 'this.handlerz[')), /does not look its handler up/);
    bad('the class has no handlers field', fetchFamily(edit('handlers={', 'handlerz={')), /has 0 `handlers=\{\.\.\.\}` fields/);
    bad('the class has two handlers fields', fetchFamily(edit('handlers={', 'handlers={};handlers={')), /has 2 `handlers=\{\.\.\.\}` fields/);
  });
}

// ---- the fetch handler map on synthetic shapes (no stock app needed): the dispatcher anchor, the class and the field, and what each drift does ----
const OBJ = (n, extra = '') => `{${Array.from({ length: n }, (_, i) => `"handler-${i}":async()=>({})`).join(',')}${extra}}`;
const DISPATCHER = 'handleVSCodeRequest(e,t,n,r,o){try{let s=t,c=this.handlers[s];if(typeof c!=`function`)throw Error(`${t} not implemented in the current Electron process. Restart to load the latest handlers.`);return c({...n,origin:e})}catch(e){throw e}}';
const synth = (main) => ({
  list: () => ['package.json', '.vite/build/main-abc12345.js', 'webview/assets/x-0123456789ab.js'],
  read: (p) => (p === 'package.json' ? JSON.stringify({ name: 'synthetic', version: '1.0.0', codexBuildNumber: '1' }) : p.startsWith('.vite/') ? main : 'export{}'),
  size: () => 1,
});
const SCHEMAS = join(here, '..', '..', 'contracts', 'upstream', '26.1016.62342-21477');
const fetchOf = (main) => census(synth(main), join(SCHEMAS, 'schema'), join(SCHEMAS, 'schema-experimental'), { only: ['bus.fetchHandlers'] }).families['bus.fetchHandlers'];

test('synthetic: the handler map is the one field of the class that holds the dispatcher; spreads are resolved; keys are sorted and counted', () => {
  const main = `var X=1;class Other{handlers={"not-ours":1}}var Y=class extends u.Base{a=1;constructor(e){this.handlers=e}handlers=${OBJ(24, ',...mk({a:1}),"z-last":async()=>1')};${DISPATCHER}};function mk(e){let t=1;return t,{"spread-a":async()=>1,"spread-b":async()=>2}}`;
  const f = fetchOf(main);
  assert.equal(f.status, 'ok', f.error);
  assert.equal(f.count, 27);
  assert.ok(f.values.includes('spread-a') && f.values.includes('spread-b') && f.values.includes('z-last') && !f.values.includes('not-ours'));
  assert.deepEqual(f.values, [...f.values].sort());
  assert.deepEqual(f.files, ['main-process:main']);
});

test('synthetic: the handler map fails closed when the dispatcher, its class, its field or the object drift', () => {
  const good = (cls = `class A{handlers=${OBJ(25)};${DISPATCHER}}`) => cls;
  assert.equal(fetchOf(good()).status, 'ok');
  const bad = (what, main, re) => { const f = fetchOf(main); assert.equal(f.status, 'fail', what); assert.equal(f.values, undefined, what); assert.match(f.error, re, what); };
  bad('no dispatcher', good().replace('not implemented in the current Electron process', 'is missing'), /dispatcher.*matched 0 times/);
  bad('two dispatchers', `${good()};${good()}`, /dispatcher.*matched 2 times/);
  bad('the lookup changed', good().replace('this.handlers[s]', 'this.table[s]'), /does not look its handler up/);
  bad('not in a class', `var A={handlers:${OBJ(25)},${DISPATCHER}}`, /not inside a class body/);
  bad('no field', good().replace('handlers=', 'handlerz='), /has 0 `handlers=\{\.\.\.\}` fields/);
  bad('two fields', good().replace('handlers=', 'handlers={};handlers='), /has 2 `handlers=\{\.\.\.\}` fields/);
  bad('the field is not an object literal', good().replace(`handlers=${OBJ(25)}`, 'handlers=build()'), /has 0 `handlers=\{\.\.\.\}` fields/);
  // 22943 keeps one handler (the rest are AppHost services): any entry is enough, none is a drift
  assert.equal(fetchOf(good(`class A{handlers=${OBJ(1)};${DISPATCHER}}`)).status, 'ok');
  bad('no entries', good(`class A{handlers=${OBJ(0)};${DISPATCHER}}`), /handler object has 0 entries/);
  bad('an entry that is neither a key nor a spread', good(`class A{handlers=${OBJ(25, ',(1+2)')};${DISPATCHER}}`), /neither keys nor spreads/);
});
