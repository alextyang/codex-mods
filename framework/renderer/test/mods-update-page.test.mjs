// The Update page (docs/design/framework-ui.md F2, F11; systems.md E6.3): the copy's update and its review, or an empty state; read and acted on through the graph.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findAll } from './fake-react.mjs';
import { pagesFixture, modRef, at, flush, P, textOf } from './pages-fixture.mjs';
import { createUpdatePage, groupOf, reasonOf, pairOf, supportOf, GROUPS } from '../present/mods-update-page.mjs';
import { updateSays, CHATS_NAMED, RUNNING_CHATS } from '../present/mods-update.mjs';

function setup(o = {}) {
  const f = pagesFixture(o);
  const asks = { intent: o.intent ?? null };
  const page = createUpdatePage({ ...f.base, takeIntent: (k) => { const was = asks.intent === k; asks.intent = null; return was; }, hasIntent: (k) => asks.intent === k });
  return { ...f, ...f.mount(() => f.e(page.UpdatePage)), asks };
}

test('none waiting: Codex is up to date, with its version and Check for updates; a check that could not complete does not say so', async () => {
  const t = setup({ app: { version: '26.1027.30824' }, fw: { lastChecked: at('2026-10-28T02:00:00Z') } });
  assert.match(t.text(), /^UpdateCodex is up to dateYou have Codex 26\.1027\. Mods are checked again when the next update arrives\.Check for updatesLast checked 2026-10-28/);
  await t.buttonIn(t.root.tree, 'Check for updates').props.onClick();
  assert.deepEqual(t.calls, [['CodexMods', 'codexmods', 'checkForUpdates', []]]);
  assert.doesNotMatch(setup().text(), /You have Codex/, 'a version it does not know is not said');
  const u = setup({ app: { version: '26.1027.30824' }, fw: { checkProblem: 'the release source cannot be reached.' } });
  assert.match(u.text(), /^UpdateCouldn’t check for updatesthe release source cannot be reached\. You have Codex 26\.1027\./);
  assert.doesNotMatch(u.text(), /up to date/);
  const r = setup({ invoke: () => ({ status: 'refused', message: 'not now' }) });
  await r.buttonIn(r.root.tree, 'Check for updates').props.onClick();
  await flush();
  assert.match(r.text(), /not now/);
});

const BUILD = { from: '26.1016.1', to: '26.1017.2' };
const summary = (t) => t.all((n) => n.props?.className === 'cmk-summary')[0];
const panel = (t) => t.all((n) => n.props?.className === 'cmk-panel')[0];
const note = (t) => t.all((n) => n.props?.className === 'cmk-panel-note')[0];

test('F11: what is offered, by where it stands: not prepared (Prepare), preparing by step (Cancel is Later), ready (Restart to update), being applied; why it could not be prepared; Later', async () => {
  const u = setup({ update: { state: 'available', build: BUILD, problem: 'no space for the copy', dismissed: true } });
  assert.match(textOf(summary(u)), /^Codex 26\.1017 is available26\.1016 → 26\.1017It could not be prepared: no space for the copyYou chose Later: it stays here without asking again\.Prepare update$/);
  await u.buttonIn(summary(u), 'Prepare update').props.onClick();
  assert.deepEqual(u.calls, [['CopyUpdate', 'copy', 'download', []]]);
  const busy = setup({ update: { state: 'available', build: BUILD }, ops: [{ id: 'o', state: { kind: 'update', outcome: 'running' } }] });
  assert.equal(busy.buttonIn(summary(busy), 'Prepare update').props.disabled, true, 'not while an operation runs');
  const p = setup({ update: { state: 'downloading', build: BUILD, step: 'candidate', support: { status: 'checking' } } });
  assert.match(textOf(summary(p)), /^Preparing Codex 26\.1017.*Step: building the new copyCancelPreparing…$/);
  assert.equal(p.buttonIn(summary(p), 'Preparing…').props.disabled, true);
  assert.match(textOf(panel(p)), /Checking support for Codex 26\.1017: building the new copy\.Checking/);
  await p.buttonIn(summary(p), 'Cancel').props.onClick();
  assert.deepEqual(p.calls, [['CopyUpdate', 'copy', 'later', []]], 'Cancel means later');
  // Prepare's call lasts as long as the preparation: Cancel is not held by it (found natively)
  const long = setup({ update: { state: 'available', build: BUILD }, invoke: (ref, op) => (op === 'download' ? new Promise(() => {}) : { status: 'done' }) });
  long.buttonIn(summary(long), 'Prepare update').props.onClick();
  long.setUpdate({ state: 'downloading', build: BUILD, step: 'candidate', support: { status: 'checking' } });
  long.show();
  assert.equal(long.buttonIn(summary(long), 'Cancel').props.disabled, false);
  await long.buttonIn(summary(long), 'Cancel').props.onClick();
  assert.deepEqual(long.calls.map((c) => c[2]), ['download', 'later']);
  const r = setup({ update: { state: 'ready', plan: 'plan-1', build: BUILD, framework: { from: '1.0.0', to: '1.0.1' }, support: { status: 'ships' } } });
  assert.match(textOf(summary(r)), /^Codex 26\.1017 is ready to install26\.1016 → 26\.1017 · framework 1\.0\.0 → 1\.0\.1Restart to update…$/);
  r.buttonIn(summary(r), 'Restart to update…').props.onClick();
  assert.match(r.dialogText(), /^Update to Codex 26\.1017 with framework 1\.0\.1\?/, 'its review, named as the page names it');
  const i = setup({ update: { state: 'installing', plan: 'plan-1', build: BUILD } });
  assert.match(textOf(summary(i)), /^Codex 26\.1017 is being applied.*Restarting…$/);
  const fw = setup({ update: { state: 'available', framework: { from: '1.0.0', to: '1.0.1' } }, app: { version: '26.1016.1' } });
  assert.match(textOf(summary(fw)), /^Framework 1\.0\.1 is available/, 'a framework release alone names itself');
});

test('F11: the framework card from explicit outcomes, and its note; never an automatic update it will not make', () => {
  const card = (support, extra = {}) => supportOf({ support, framework: { from: '1.0.0', to: '1.0.1' }, ...extra }, '1.0.0', 'Codex 26.1017');
  assert.deepEqual(card({ status: 'ships' }), { version: '1.0.1', detail: 'Supports Codex 26.1017. Installs with the update.', pill: ['Compatible', 'success', 'check'] });
  assert.match(card({ status: 'ships', listed: false }).detail, /does not list this build as tested/);
  assert.deepEqual(card({ status: 'already' }).pill[0], 'Compatible');
  assert.equal(card({ status: 'already' }).version, '1.0.0', 'the framework that runs');
  assert.deepEqual([card({ status: 'notYet' }).detail, card({ status: 'notYet' }).pill[0]], ['No framework release supports Codex 26.1017 yet.', 'Not supported yet']);
  assert.deepEqual([card({ status: 'unknown', problem: 'the release source cannot be reached.' }).detail, card({ status: 'unknown' }).pill[0]], ['Couldn’t check support for Codex 26.1017. the release source cannot be reached.', 'Unknown']);
  assert.match(card({ status: 'notChecked' }).detail, /^Not checked yet/);
  const auto = setup({ update: { state: 'ready', plan: 'p', build: BUILD, support: { status: 'already' }, automatic: { will: true } } });
  assert.match(textOf(note(auto)), /Codex updates automatically the next time it restarts\./);
  const tried = setup({ update: { state: 'ready', plan: 'p', build: BUILD, support: { status: 'already' }, automatic: { will: false, why: 'tried' },
    lastApply: { outcome: 'reverted', at: at('2026-11-03T10:00:00Z'), note: 'it did not start healthy' } } });
  assert.equal(note(tried), undefined, 'no promise');
  assert.match(textOf(tried.all((n) => n.props?.className === 'cmk-banner')[0]), /^The update was undoneit did not start healthy Codex stayed on 26\.1016\. It is not applied on its own again\./);
  const held = setup({ update: { state: 'ready', plan: 'p', build: BUILD, support: { status: 'already' }, held: true } });
  assert.match(textOf(note(held)), /Some mods may not work on Codex 26\.1017\. Updating anyway turns them off until you turn them on again\./);
  const unknown = setup({ update: { state: 'available', build: BUILD, support: { status: 'unknown' } } });
  assert.match(textOf(summary(unknown)), /^Couldn’t check mods support for Codex 26\.1017/);
  assert.match(textOf(note(unknown)), /Codex won’t update until mods support is confirmed\. Your mods keep running on Codex 26\.1016\./);
  assert.ok(unknown.buttonIn(summary(unknown), 'Try again'));
});

test('F11: waiting for mods support: Use original Codex asks first, then opens it', async () => {
  const t = setup({ update: { state: 'available', build: BUILD, support: { status: 'notYet' } } });
  assert.match(textOf(summary(t)), /^Codex 26\.1017 is waiting for mods support/);
  assert.match(textOf(note(t)), /Your mods keep running on Codex 26\.1016\. Check again later, or use the original Codex for Codex 26\.1017\./);
  t.buttonIn(summary(t), 'Use original Codex…').props.onClick();
  assert.match(t.dialogText(), /^Use Codex without mods\?The original Codex app opens and updates to 26\.1017 on its own\. Mods aren’t available there\./);
  assert.deepEqual(t.calls, [], 'not before you choose');
  await t.inDialog('Open original Codex').props.onClick();
  await flush();
  assert.deepEqual(t.calls, [['CopyUpdate', 'copy', 'openOriginal', []]]);
  assert.equal(t.dialog(), undefined);
});

test('F11: your mods, grouped by what the update does to them, each with its reason and where it stands now and after', () => {
  const v = (o) => ({ mod: modRef('a.one'), version: '1.0.0', on: true, now: 'compatible', after: 'compatible', unknown: false, tested: false, uses: [], changed: [], ...o });
  assert.equal(groupOf(v({ on: false, after: 'blocked' })), 'off');
  assert.equal(groupOf(v({ now: 'blocked' })), 'off', 'one that does not load now is off');
  assert.equal(groupOf(v({ after: 'blocked', candidate: { version: '1.1.0', after: 'compatible', addedPermissions: [], from: 'github' } })), 'update');
  assert.equal(groupOf(v({ after: 'blocked', candidate: { version: '1.1.0', after: 'atRisk', addedPermissions: [], from: 'release' } })), 'incompatible', 'a candidate that does not fix it');
  assert.equal(groupOf(v({ after: 'atRisk', changed: ['The composer'] })), 'affected');
  assert.equal(groupOf(v({ after: 'atRisk', unknown: true })), 'unchecked');
  assert.equal(groupOf(v({ after: 'degraded' })), 'degraded');
  assert.equal(groupOf(v({ tested: true })), 'compatible');
  assert.equal(groupOf(v()), 'notAffected');
  const V = 'Codex 26.1017';
  assert.equal(reasonOf(v({ uses: ['The sidebar', 'The composer', 'Threads'] }), 'notAffected', V), 'Uses The sidebar, The composer and Threads');
  assert.equal(reasonOf(v(), 'notAffected', V), 'Declares no app parts', 'never claims it was checked');
  assert.equal(reasonOf(v({ changed: ['The composer'] }), 'affected', V), 'Uses The composer, which changed');
  assert.equal(reasonOf(v({ candidate: { version: '1.1.0', addedPermissions: ['secrets'] } }), 'update', V), '1.1.0 works with Codex 26.1017 · asks for a new permission');
  assert.equal(reasonOf(v({ after: 'blocked' }), 'off', V), 'If turned back on, it won’t load on Codex 26.1017');
  assert.equal(reasonOf(v({ missing: ['The status bar'] }), 'degraded', V), 'Works without The status bar');
  assert.equal(reasonOf(v({ unchecked: ['A', 'B', 'C', 'D', 'E'] }), 'degraded', V), 'Can use A, B, C and 2 more, which couldn’t be checked', 'what it is, and never a long list');
  assert.equal(reasonOf(v({ missing: ['The composer'], changed: ['The composer'] }), 'incompatible', V), 'Needs The composer, which Codex 26.1017 lacks');
  assert.deepEqual(pairOf(v({ after: 'blocked' }), 'incompatible'), { now: 'works', after: 'wont' });
  assert.deepEqual(pairOf(v({ after: 'blocked' }), 'update'), { now: 'updateAvail', after: 'compatible' });
  assert.deepEqual(pairOf(v(), 'notAffected', true), { now: 'stopped', after: 'notAffected' });
  assert.deepEqual(GROUPS.map(([k]) => k), ['incompatible', 'affected', 'unchecked', 'degraded', 'update', 'compatible', 'notAffected', 'off']);
  const t = setup({ mods: { 'a.one': { name: 'One' }, 'b.two': { name: 'Two', release: { version: '2.1.0', notes: '', addedPermissions: [], verdict: 'compatible' } }, 'c.three': { name: 'Three' }, 'd.four': { name: 'Four', status: 'disabled' } },
    update: { state: 'ready', plan: 'p', build: BUILD, support: { status: 'already' }, verdicts: [
      v({ mod: modRef('a.one'), after: 'atRisk', changed: ['The composer'] }),
      v({ mod: modRef('b.two'), version: '2.0.0', after: 'blocked', candidate: { version: '2.1.0', after: 'compatible', addedPermissions: [], from: 'github' } }),
      v({ mod: modRef('c.three'), after: 'blocked', candidate: { version: '3.1.0', after: 'compatible', addedPermissions: ['secrets'], from: 'release' } }),
      v({ mod: modRef('d.four'), on: false, after: 'compatible', tested: true }),
    ] } });
  const groups = t.all((n) => n.props?.className === 'cmk-group').map((g) => g.props['aria-label']);
  assert.deepEqual(groups, ['Affected mods', 'Compatible update mods', 'Off mods']);
  assert.match(textOf(t.all((n) => n.props?.['data-codexmods-mod'] === 'a.one')[0]), /^Onev1\.0\.0Uses The composer, which changed→$/);
  assert.match(textOf(note(t)), /^1 mod may not work on Codex 26\.1017\.$/);
  const pair = findAll(t.all((n) => n.props?.['data-codexmods-mod'] === 'a.one')[0], (n) => n.props?.role === 'img').map((n) => n.props['aria-label']);
  assert.deepEqual(pair, ['Works on Codex 26.1016', 'Not tested, affected on Codex 26.1017']);
  const two = t.all((n) => n.props?.['data-codexmods-mod'] === 'b.two')[0];
  assert.ok(t.buttonIn(two, 'Update'), 'its GitHub release runs here: applied now');
  const three = t.all((n) => n.props?.['data-codexmods-mod'] === 'c.three')[0];
  assert.match(textOf(three), /3\.1\.0 works with Codex 26\.1017 · asks for a new permissionUpdates with Codex 26\.1017/, 'the release\'s version comes with the update');
  assert.match(textOf(t.all((n) => n.props?.['data-codexmods-mod'] === 'd.four')[0]), /If turned back on, it works on Codex 26\.1017/);
  assert.match(t.text(), /Your modsCodex 26\.1016 → Codex 26\.1017/);
  const none = setup({ update: { state: 'available', build: BUILD, support: { status: 'notYet' }, verdicts: [v()] } });
  assert.equal(none.all((n) => n.props?.className === 'cmk-groups').length, 0, 'only with a build the framework supports');
});

test('F11: Update from a row and Update all apply the GitHub releases that run now; What’s new when known', async () => {
  const rel = (version) => ({ version, notes: '', addedPermissions: [], verdict: 'compatible' });
  const v = (id, version) => ({ mod: modRef(id), version: '1.0.0', on: true, now: 'compatible', after: 'blocked', unknown: false, tested: false, uses: [], changed: [], candidate: { version, after: 'compatible', addedPermissions: [], from: 'github' } });
  const t = setup({ mods: { 'a.one': { name: 'One', release: rel('1.1.0') }, 'b.two': { name: 'Two', release: rel('2.1.0') } },
    update: { state: 'ready', plan: 'p', build: BUILD, support: { status: 'already' }, notes: '- Faster loading\n- Rename worktrees', verdicts: [v('a.one', '1.1.0'), v('b.two', '2.1.0')] } });
  assert.match(t.text(), /What’s new in Codex 26\.1017Faster loadingRename worktrees/);
  await t.buttonIn(t.all((n) => n.props?.className === 'cmk-group')[0], 'Update all').props.onClick();
  await flush();
  assert.deepEqual(t.calls, [['Mod', 'a.one', 'applyUpdate', []], ['Mod', 'b.two', 'applyUpdate', []]]);
  assert.doesNotMatch(setup({ update: { state: 'ready', plan: 'p', build: BUILD } }).text(), /What’s new/, 'left out when not known');
});

test('its review: the build, the framework and the mods, consent for a mod asking more, the chats it stops; Apply names the plan seen', async () => {
  const threads = Array.from({ length: 7 }, (_, i) => ({ title: `Chat ${i + 1}`, status: i === 6 ? 'idle' : 'working' }));
  const t = setup({ mods: { 'a.one': { name: 'One' }, 'b.two': { name: 'Two' } }, threads, update: {
    plan: 'plan-1', build: { from: '26.1016.1', to: '26.1017.2' }, framework: { from: '1.0.0', to: '1.0.1' },
    mods: [{ mod: modRef('a.one'), from: '1.0.0', to: '1.0.1', addedPermissions: [] }, { mod: modRef('b.two'), from: '2.0.0', to: '2.1.0', addedPermissions: ['graph.act:Thread.archive'] }],
  } });
  t.buttonIn(summary(t), 'Restart to update…').props.onClick();
  const d = t.dialogText();
  assert.match(d, /^Update to Codex 26\.1017 with framework 1\.0\.1\?Codex 26\.1016 → 26\.1017Framework 1\.0\.0 → 1\.0\.1One 1\.0\.0 → 1\.0\.1Two 2\.0\.0 → 2\.1\.0/);
  assert.match(d, /Two 2\.1\.0 asks for more: graph\.act:Thread\.archive\. Without your consent it stays at 2\.0\.0\./);
  assert.match(d, /these 6 chats stop: Chat 1, Chat 2, Chat 3, Chat 4, Chat 5 and 1 more\./);
  assert.equal(CHATS_NAMED, 5);
  assert.deepEqual(t.queries, [RUNNING_CHATS]);
  const consent = findAll(t.dialog(), (n) => n.type === 'switch')[0];
  assert.equal(consent.props['aria-label'], 'Update Two with its new permissions');
  consent.props.onChange(true);
  await t.inDialog('Apply').props.onClick();
  assert.deepEqual(t.calls, [['CopyUpdate', 'copy', 'apply', ['plan-1', false, [modRef('b.two')]]]]);
  assert.equal(t.dialog(), undefined, 'it closes once applied');
  assert.deepEqual(updateSays({ state: 'ready', held: true }), ['Prepared', 'Held: some mods may not work on it']);
});

test('a held update is applied anyway naming the mods it leaves behind, or put off with Later; a plan changed meanwhile is not applied', async () => {
  const feature = { type: 'Feature', provider: P, id: 'slot:composer' };
  const t = setup({ mods: { 'a.one': { name: 'One' } }, update: { plan: 'plan-1', held: true, risks: [{ mod: modRef('a.one'), feature, sentence: 'It needs the composer, which changed.' }] } });
  t.put(feature, { state: { title: 'The composer' } });
  assert.match(textOf(note(t)), /Some mods may not work on this version of Codex/);
  t.buttonIn(summary(t), 'Restart to update…').props.onClick();
  assert.match(t.dialogText(), /One: It needs the composer, which changed\. \(The composer\)/);
  assert.match(t.dialogText(), /Apply anyway leaves One behind: turned off on the new build until you turn them on again\./);
  assert.match(t.dialogText(), /no chat is working now/);
  assert.equal(t.inDialog('Apply anyway').props.color, 'danger');
  assert.equal(t.inDialog('Apply'), undefined);
  t.setUpdate({ plan: 'plan-2', held: true, risks: [] });
  t.show();
  assert.match(t.dialogText(), /The update changed since you opened this/);
  assert.equal(t.inDialog('Apply anyway').props.disabled, true);
  t.setUpdate({ plan: 'plan-1', held: true, risks: [{ mod: modRef('a.one'), sentence: 'x' }] });
  t.show();
  await t.inDialog('Apply anyway').props.onClick();
  assert.deepEqual(t.calls, [['CopyUpdate', 'copy', 'apply', ['plan-1', true, []]]]);
  t.buttonIn(summary(t), 'Restart to update…').props.onClick();
  await t.inDialog('Later').props.onClick();
  assert.deepEqual(t.calls[1], ['CopyUpdate', 'copy', 'later', []]);
});

test('the band\'s Open of the update shows its review at once, with the plan first read', () => {
  const t = setup({ update: { plan: 'plan-1' }, intent: 'update' });
  assert.match(t.dialogText(), /^Update to 26\.1017 with framework 1\.0\.1\?/);
  assert.doesNotMatch(t.dialogText(), /changed since you opened this/);
  t.setUpdate({ plan: 'plan-2' });
  t.show();
  assert.match(t.dialogText(), /changed since you opened this/, 'the plan it showed is the one named');
  const shown = setup({ update: { plan: 'plan-1' } });
  assert.equal(shown.dialog(), undefined, 'without the band\'s ask, no Dialog');
  shown.asks.intent = 'update';
  shown.show();
  shown.show();
  assert.match(shown.dialogText(), /^Update to 26\.1017 with framework 1\.0\.1\?/, 'the ask arriving while the page is shown opens it (E6 review)');
});

test('E6.5: the update\'s row is reported; a page in safe mode says so', () => {
  const t = setup({ update: { plan: 'p' } });
  assert.deepEqual(t.reported(), [['SettingsRow', 'CopyUpdate', 'copy', 'codexMods', 'update']]);
  assert.match(setup({ fw: { safeMode: true } }).text(), /Mods are off/);
  assert.equal(setup({ noFramework: true }).text(), 'Update');
});
