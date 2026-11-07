// A mod's page (docs/design/framework-ui.md F2, F4; systems.md S21, E6.2): its title block, one banner, its tabs, and About with its versions, data and Uninstall; consent in a Dialog
// that names the request it showed; each action that cannot be undone asked first; read and acted on through the graph.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findAll } from './fake-react.mjs';
import { pagesFixture, modRef, opRef, at, flush, textOf } from './pages-fixture.mjs';
import { createModPage, requestPermissions, OPERATIONS } from '../present/mod-page.mjs';
import { sizeOf } from '../present/mods-text.mjs';

const PERMS = [
  { id: 'ui', text: 'Can add controls', risk: 'low', granted: true },
  { id: 'net', text: 'Can reach the network', risk: 'high', granted: true },
  { id: 'files', text: 'Can read your files', risk: 'medium', granted: false },
];
const MOD = 'acme.demo';

function setup({ state = {}, ops = [], invoke, pickFile = async () => '/Users/x/demo-1.1.codexmod', review = false, appDialog = true, lost = [], features = [], tab, links = {}, own = [], rows = null, fw = {} } = {}) {
  const f = pagesFixture({ order: [MOD], ops, invoke, pickFile, appDialog, fw, ...(state === null ? {} : {}) });
  const setMod = (s) => f.setMod(MOD, { name: 'Demo', version: '1.1.0', compatibility: 'compatible', development: false, permissions: PERMS, versions: [], keptData: [], dataBytes: 0, faults: 0, ...s }, { features: features.map((x) => x.ref), ...links });
  for (const x of features) f.put(x.ref, { state: x.state });
  if (state !== null) setMod(state);
  let pending = review;
  const faults = [], details = [];
  const page = createModPage({ ...f.base, overviewPath: '/settings/codexmods', rows,
    pathOf: (id, t) => `/settings/codexmods/${id}${t ? `/${t}` : ''}`, ownPathOf: (id, p) => `/settings/codexmods/${id}/~${p}`,
    ownTabs: () => own, renderOwn: (id, p) => `the page ${p} of ${id}`,
    takeReview: (id) => { const was = pending && id === MOD; pending = false; return was; },
    lostRulesOf: (id) => (id === MOD ? lost : []), showDetail: (r) => details.push(r), onModFault: (modId, error) => faults.push([modId, String(error?.message ?? error)]) });
  const m = f.mount(() => f.e(page.ModPage, { modId: MOD, tab }));
  const tabs = () => m.all((n) => n.props?.role === 'tab');
  return { ...f, ...m, setMod: (s) => setMod(s), faults, details, tabs, pageMenu: (label) => m.menuItem(m.all((n) => n.type === 'menu')[0], label) };
}

test('the title block: its name, description, status and version, with its switch; the back button goes to the list', async () => {
  const t = setup({ state: { description: 'Keeps time' } });
  assert.match(t.text(), /^ModsDemoKeeps timeOn· v1\.1\.0/);
  assert.equal(t.all((n) => n.type === 'h1')[0].props.className, 'heading-xl');
  t.buttonIn(t.root.tree, 'Mods').props.onClick();
  assert.deepEqual(t.navigated, ['/settings/codexmods']);
  const sw = t.all((n) => n.type === 'switch')[0];
  assert.equal(sw.props['aria-label'], 'Turn Demo off');
  await sw.props.onChange(false);
  assert.deepEqual(t.calls, [['Mod', MOD, 'disable', []]]);
  const off = setup({ state: { status: 'disabled', development: true } });
  assert.match(off.text(), /^ModsDemoOff· v1\.1\.0 · Local/);
  assert.equal(off.all((n) => n.type === 'switch')[0].props['aria-label'], 'Turn Demo on');
  const safe = setup({ fw: { safeMode: true } });
  assert.match(safe.text(), /^ModsMods are off.*DemoOff in safe mode/);
  assert.equal(safe.all((n) => n.type === 'switch')[0].props.disabled, true);
  const busy = setup({ ops: [{ id: 'op-9', mod: MOD, state: { kind: 'update', outcome: 'running', phase: 'stage' } }] });
  assert.equal(busy.all((n) => n.type === 'switch')[0].props.disabled, true, 'an operation running makes the controls wait');
  const reloading = setup({ state: { reloading: true } });
  assert.match(reloading.text(), /^ModsDemoReloading· v1\.1\.0/);
  assert.equal(reloading.all((n) => n.type === 'switch')[0].props.disabled, true);
  assert.equal(reloading.pageMenu('Reload').props.disabled, true);
});

test('one banner, what most needs you first: its package unreadable, stopped, blocked, waiting for you', async () => {
  const banner = (t) => t.all((n) => n.props?.className === 'cmk-banner').map((n) => textOf(n));
  const request = { id: 'r', kind: 'update', version: '1.2.0', permissions: [], addedPermissions: [] };
  assert.match(banner(setup({ state: { status: 'enabled', consentRequest: request } }))[0], /^Update to 1\.2\.0It asks for no more permissions\.Review…/);
  assert.match(banner(setup({ state: { status: 'quarantined', problem: 'unreadable' } }))[0], /^Its package can’t be readunreadable/);
  assert.equal(banner(setup({ state: { status: 'quarantined', quarantine: { reason: 'x', at: 1 }, compatibility: 'blocked', consentRequest: request } })).length, 1, 'never more than one');
  const stopped = setup({ state: { status: 'quarantined', quarantine: { reason: 'unresponsive', at: 1 } } });
  assert.match(banner(stopped)[0], /^Stopped after an errorunresponsiveReloadView activity/);
  assert.match(banner(setup({ state: { status: 'quarantined', quarantine: { reason: 'faults', at: 1 }, lastFault: { at: 1, message: 'It threw', where: 'render' } } }))[0], /^Stopped after an errorIt threw \(render\)/);
  await stopped.buttonIn(stopped.all((n) => n.props?.className === 'cmk-banner')[0], 'Reload').props.onClick();
  stopped.buttonIn(stopped.root.tree, 'View activity').props.onClick();
  assert.deepEqual(stopped.calls, [['Mod', MOD, 'reload', []]]);
  assert.deepEqual(stopped.navigated, ['/settings/codexmods/acme.demo/activity']);
  assert.doesNotMatch(banner(setup({ tab: 'activity', state: { status: 'quarantined', quarantine: { reason: 'x', at: 1 } } }))[0], /View activity/, 'it is already there');
  const blocked = setup({ state: { status: 'quarantined', compatibility: 'blocked', reasons: ['Built for an older Codex.'] } });
  assert.match(banner(blocked)[0], /^Doesn’t support this version of CodexBuilt for an older Codex\.Check for updates/);
  assert.match(setup({ state: { status: 'quarantined', compatibility: 'blocked' } }).text(), /Not loaded/);
  assert.deepEqual(banner(setup()), [], 'all is well');
  assert.deepEqual(banner(setup({ state: { status: 'quarantined', quarantine: { reason: 'x', at: 1 }, reloading: true } })), [], 'none while it reloads');
});

test('F6: what it says of itself: its author as its own claim, its paragraphs, its images asked for when shown, when it was installed; opening its page ends new', async () => {
  const t = setup({ state: { author: 'Acme', about: ['First.', 'Second.'], description: 'Keeps time', installedAt: at('2026-10-20T08:00:00Z'), media: [{ id: 'one', caption: 'The first', aspect: '3 / 1' }, { id: 'two' }], new: true },
    invoke: (ref, op, args) => (op === 'image' ? { status: 'done', value: args[0] === 'one' ? 'data:image/png;base64,AAAA' : undefined } : { status: 'done' }) });
  await flush();
  t.show();
  assert.match(t.text(), /AboutFirst\.Second\.The first/);
  assert.match(t.text(), /Author \| What the mod says of itself \| Acme/);
  assert.match(t.text(), /Installed \| {2}\| 2026-10-20/);
  const [one, two] = t.all((n) => n.type === 'figure');
  assert.equal(findAll(one, (n) => n.type === 'img')[0].props.src, 'data:image/png;base64,AAAA');
  assert.equal(findAll(one, (n) => n.type === 'img')[0].props.alt, 'The first');
  assert.equal(findAll(one, (n) => n.props?.className === 'cmk-media-frame')[0].props.style.aspectRatio, '3 / 1');
  assert.equal(findAll(two, (n) => n.type === 'img').length, 0, 'a frame until it comes, and if it cannot');
  assert.deepEqual(t.calls.filter((c) => c[2] === 'image').map((c) => c[3]), [['one'], ['two']]);
  assert.deepEqual(t.calls.filter((c) => c[2] === 'markSeen').map((c) => c[1]), [MOD]);
  const plain = setup({ state: { description: 'Keeps time' } });
  assert.match(plain.text(), /AboutKeeps time/);
  assert.equal(plain.calls.filter((c) => c[2] === 'markSeen').length, 0);
});

test('the tabs: Settings while it has any, its own pages, Permissions with a count, Activity with a dot; the first has no suffix; an unknown one is the first', () => {
  const section = { type: 'SettingsSection', id: `mod:${MOD}` };
  const rows = { ModSettings: ({ sectionRef }) => `settings of ${sectionRef.id}` };
  const t = setup({ links: { settings: section }, rows, own: [{ id: 'usage', title: 'Live usage' }] });
  const labels = () => t.tabs().map((n) => textOf(n));
  assert.deepEqual(labels(), ['Settings', 'Live usage', 'Permissions3', 'Activity']);
  assert.match(t.text(), /settings of mod:acme\.demo/);
  t.tabs()[1].props.onClick();
  t.tabs()[2].props.onClick();
  t.tabs()[3].props.onClick();
  t.tabs()[0].props.onClick();
  assert.deepEqual(t.navigated, ['/settings/codexmods/acme.demo/~usage', '/settings/codexmods/acme.demo/permissions', '/settings/codexmods/acme.demo/activity', '/settings/codexmods/acme.demo']);
  const own = setup({ links: { settings: section }, rows, own: [{ id: 'usage', title: 'Live usage' }], tab: '~usage' });
  assert.match(own.text(), /the page usage of acme\.demo/);
  assert.equal(own.tabs().find((n) => n.props['aria-selected']).children[1], 'Live usage');
  const bare = setup({ state: { permissions: [] } });
  assert.deepEqual(bare.tabs().map((n) => textOf(n)), ['Permissions', 'Activity'], 'no settings: Permissions is first, with no count');
  assert.match(bare.text(), /No access to files, chats, commands or the network\./);
  bare.tabs()[0].props.onClick();
  assert.deepEqual(bare.navigated, ['/settings/codexmods/acme.demo']);
  const gone = setup({ tab: '~gone' });
  assert.equal(gone.tabs().find((n) => n.props['aria-selected']).children[1], 'Permissions');
  assert.equal(setup({ state: { status: 'quarantined', quarantine: { reason: 'x', at: 1 } } }).tabs()[1].children.some((c) => c.props?.className === 'cmk-tab-dot'), true);
  assert.equal(setup({ ops: [{ id: 'o', mod: MOD, state: { kind: 'update', outcome: 'needsAttention' } }] }).tabs()[1].children.some((c) => c.props?.className === 'cmk-tab-dot'), true);
  assert.equal(setup().tabs()[1].children.some((c) => c.props?.className === 'cmk-tab-dot'), false);
});

test('About closes every tab: what it says of itself, its details, kept versions and data, Uninstall', () => {
  for (const tab of ['permissions', 'activity']) {
    const t = setup({ tab, state: { description: 'Keeps time', publisher: 'ab12cd', reasons: ['The composer is missing.'], compatibility: 'degraded', availableVersion: '1.2.0', dataBytes: 2_621_440,
      versions: [{ version: '1.0.0', codeOnly: true, withData: true }, { version: '0.9.0', codeOnly: false, withData: true }],
      keptData: [{ generation: '2026-10-20T08:00:00.000Z', at: at('2026-10-20T08:00:00Z'), version: '1.0.0', bytes: 4096 }] } });
    const text = t.text();
    assert.match(text, /AboutKeeps time/);
    assert.match(text, /Version \| 1\.2\.0 is waiting for your consent \| 1\.1\.0/);
    assert.match(text, /Publisher \| Its signing key's fingerprint \| ab12cd/);
    assert.match(text, /Compatibility \| The composer is missing\. \| Works, with parts missing/);
    assert.match(text, /Version 1\.0\.0 \| Kept: it can come back with the data as it is now, or with its own data/);
    assert.match(text, /Version 0\.9\.0 \| Kept: it can come back with its own data/);
    assert.match(text, /Its data \| {2}\| 2\.5 MB/);
    assert.match(text, /Kept on 2026-10-20 \| From version 1\.0\.0 · 4 KB \| Reattach…/);
    assert.match(text, /Uninstall Demo \| Removes it, and its settings and data unless you keep them\. \| Uninstall…/);
  }
  assert.equal(sizeOf(0), '0 bytes');
  assert.equal(sizeOf(1536), '1.5 KB');
  assert.match(setup({ state: { development: true } }).text(), /Publisher \| A development package: unsigned/);
  assert.match(setup().text(), /Publisher \| Unsigned/);
});

test('Permissions: what it may do, the highest risk first', () => {
  const text = setup({ tab: 'permissions' }).text();
  assert.ok(text.indexOf('Can reach the network') < text.indexOf('Can read your files') && text.indexOf('Can read your files') < text.indexOf('Can add controls'), 'the highest risk first');
  assert.match(text, /Can read your files \| {2}\| Waiting for your consent/, 'only a high risk is said here');
  assert.match(text, /Can reach the network \| High risk \| Required/);
  assert.match(text, /Can add controls \| {2}\| Required/);
});

test('F8: Permissions: a required one reads Required, what nothing enforces says so, an optional one is a select of what it may be, through Mod.setPermission', async () => {
  const t = setup({ tab: 'permissions', state: { permissions: [
    { id: 'ui', text: 'Can add controls', risk: 'low', granted: true, optional: false, enforced: true },
    { id: 'network', text: 'Can reach the network', risk: 'high', granted: true, optional: false, enforced: false },
    { id: 'secrets', text: 'Can keep secrets', risk: 'medium', granted: false, optional: true, enforced: true, decision: 'ask', choices: ['allow', 'ask', 'deny'], label: 'Your token', detail: 'Keeps the token you give it' },
    { id: 'graph.read', text: 'Can read everything', risk: 'high', granted: false, optional: true, enforced: true, decision: 'deny', choices: ['allow', 'deny'] },
  ] } });
  const text = t.text();
  assert.match(text, /Optional access isn’t needed for Demo to work\./);
  assert.match(text, /Can add controls \| {2}\| Required/);
  assert.match(text, /Can reach the network \| High risk \| Declared, not enforced/);
  assert.match(text, /Your token \| Keeps the token you give itCan keep secretsOptional/, 'the mod\'s words beside the framework\'s, which it never replaces');
  assert.ok(text.indexOf('Can add controls') < text.indexOf('Your token'), 'required first');
  const select = (label) => t.all((n) => n.props?.['aria-label'] === label && n.props?.className === 'cmk-select')[0];
  assert.match(textOf(select('Your token')), /Ask every time/);
  assert.match(textOf(select('Can read everything')), /Don’t allow/);
  assert.deepEqual(findAll(t.row('Can read everything'), (n) => n.type === 'menuitem').map((n) => textOf(n)), ['Allow', 'Don’t allow'], 'what cannot wait is allowed or not');
  t.menuItem(t.row('Your token'), 'Allow').props.onClick();
  await flush();
  assert.deepEqual(t.calls.at(-1), ['Mod', MOD, 'setPermission', ['secrets', 'allow']]);
});

test('F8: consent says what consent is, and what will be decided later', () => {
  const request = { id: 'req-1', kind: 'install', version: '1.1.0', permissions: ['ui'], addedPermissions: ['ui'] };
  const t = setup({ state: { status: 'pendingConsent', consentRequest: request, permissions: [
    { id: 'ui', text: 'Can add controls', risk: 'low', granted: false, optional: false },
    { id: 'secrets', text: 'Can keep secrets', risk: 'medium', granted: false, optional: true, decision: 'ask' },
    { id: 'graph.read', text: 'Can read everything', risk: 'high', granted: false, optional: true, decision: 'deny' },
  ] }, review: true });
  assert.match(t.dialogText(), /A mod runs inside Codex with your authority\. Approving it is trust in its publisher, not a sandbox/);
  assert.match(t.dialogText(), /Can keep secretsOptional · Medium risk · asks every time until you decideCan read everythingOptional · High risk · off until you allow it/);
});

test('F8: Allow now at install: what is ticked is sent with consent, as allowed from the start; one that is not enforced or cannot be allowed has no box', async () => {
  const request = { id: 'req-1', kind: 'install', version: '1.1.0', permissions: ['ui'], addedPermissions: ['ui'] };
  const t = setup({ state: { status: 'pendingConsent', consentRequest: request, permissions: [
    { id: 'ui', text: 'Can add controls', risk: 'low', granted: false, optional: false },
    { id: 'secrets', text: 'Can keep secrets', risk: 'medium', granted: false, optional: true, decision: 'ask', choices: ['allow', 'ask', 'deny'] },
    { id: 'graph.read', text: 'Can read everything', risk: 'high', granted: false, optional: true, decision: 'deny', choices: ['allow', 'deny'] },
    { id: 'network', text: 'Can reach the network', risk: 'high', granted: false, optional: true, decision: 'deny', choices: [], enforced: false },
  ] }, review: true });
  const box = (label) => t.all((n) => n.props?.role === 'checkbox' && n.props['aria-label'] === `Allow ${label}`)[0];
  const tick = (label) => { box(label).props.onClick({ stopPropagation() {} }); t.show(); };
  assert.equal(box('Can reach the network'), undefined);
  tick('Can keep secrets');
  assert.equal(box('Can keep secrets').props['aria-checked'], true);
  assert.match(t.dialogText(), /Can keep secretsOptional · Medium risk · allowed nowAllow now/);
  tick('Can read everything');
  tick('Can read everything');
  await t.inDialog('Approve and enable').props.onClick();
  await flush();
  assert.deepEqual(t.calls, [['Mod', MOD, 'consent', ['req-1', true, true, ['secrets']]]]);
  const only = setup({ state: { status: 'pendingConsent', consentRequest: { ...request, permissions: [], addedPermissions: [] }, permissions: [
    { id: 'secrets', text: 'Can keep secrets', risk: 'medium', granted: false, optional: true, decision: 'ask', choices: ['allow', 'ask', 'deny'] }] } });
  assert.match(textOf(only.all((n) => n.props?.className === 'cmk-banner')[0]), /It asks only for 1 optional permission\./, 'not "no permissions"');
  only.buttonIn(only.all((n) => n.props?.className === 'cmk-banner')[0], 'Review…').props.onClick();
  assert.match(only.dialogText(), /It needs no permissions to run\.Can keep secrets/);
  assert.match(textOf(t.all((n) => n.props?.className === 'cmk-banner')[0]), /It asks for 1 permission and 3 optional\./);
  const none = setup({ state: { status: 'pendingConsent', consentRequest: request }, review: true });
  await none.inDialog('Approve').props.onClick();
  assert.deepEqual(none.calls, [['Mod', MOD, 'consent', ['req-1', true, false]]], 'nothing ticked: nothing more sent');
});

test('F10: a newer release found: its banner, Update straight away or Review update when it asks more or comes from elsewhere; never one that cannot run here', async () => {
  const banner = (t) => t.all((n) => n.props?.className === 'cmk-banner')[0];
  const t = setup({ state: { status: 'enabled', running: true, release: { version: '1.2.0', notes: 'Faster.\nAnd more.', addedPermissions: [], verdict: 'compatible' } } });
  assert.match(textOf(banner(t)), /^Version 1\.2\.0 is availableFaster\.Update$/);
  await t.buttonIn(banner(t), 'Update').props.onClick();
  await flush();
  assert.deepEqual(t.calls, [['Mod', MOD, 'applyUpdate', []]]);
  const asks = setup({ state: { status: 'enabled', release: { version: '1.2.0', notes: '', addedPermissions: ['files'], verdict: 'compatible', repoChange: { from: 'acme/focus', to: 'other/focus' } } } });
  assert.match(textOf(banner(asks)), /It asks for a new permission\. It now comes from other\/focus\.Review update$/);
  const blocked = setup({ state: { status: 'enabled', release: { version: '2.0.0', notes: '', addedPermissions: [], verdict: 'blocked' } } });
  assert.match(textOf(banner(blocked)), /It doesn’t run on this version of Codex\./);
  assert.equal(blocked.buttonIn(banner(blocked), 'Update').props.disabled, true);
});

test('F10: where it came from, on its page and in its review; a repository that changed is said plainly; its author is its own claim', () => {
  const github = { kind: 'github', repo: 'acme/focus', tag: 'v1.1.0', digest: 'sha256:0123456789abcdef0123' };
  const t = setup({ state: { source: github, checkProblem: 'GitHub’s rate limit for requests without an account is used up. Try again later.' } });
  assert.match(textOf(t.row('Source')), /^Source \| Release v1\.1\.0 · sha256 0123456789ab… \| GitHub · acme\/focus$/);
  assert.match(textOf(t.row('Its last update check')), /rate limit/);
  assert.match(textOf(setup({ state: { source: { kind: 'folder', path: '/Users/x/dev' } } }).row('Source')), /^Source \| \/Users\/x\/dev \| Local folder$/);
  assert.match(textOf(setup({ state: { source: { kind: 'file' } } }).row('Source')), /^Source \| Installed from a \.codexmod file: a newer file updates it \| A file$/);
  assert.equal(setup({ state: {} }).row('Source'), undefined);
  const request = { id: 'req-2', kind: 'update', version: '1.2.0', publisher: 'ab12', permissions: ['ui'], addedPermissions: [], repoChange: { from: 'acme/focus', to: 'other/focus', another: true },
    source: { repo: 'other/focus', tag: 'v1.2.0', digest: 'sha256:fedcba9876543210ffff' } };
  const r = setup({ state: { source: github, author: 'Acme', consentRequest: request, availableVersion: '1.2.0' }, review: true });
  assert.match(r.dialogText(), /From GitHub · other\/focus · release v1\.2\.0 · sha256 fedcba987654…/, 'the release it is for, not the one it runs');
  assert.match(r.dialogText(), /It says it is by Acme: its own claim; the publisher’s key is what identifies it\./);
  assert.match(r.dialogText(), /It comes from another repositoryIt came from acme\/focus; this update comes from other\/focus\./);
  const moved = setup({ state: { source: github, consentRequest: { ...request, repoChange: { from: 'acme/focus', to: 'acme/focus-mod', another: false } }, availableVersion: '1.2.0' }, review: true });
  assert.match(moved.dialogText(), /Its repository was renamed or moved/);
});

test('Activity: its feed, what stopped it, its own operations, the newest first, with Acknowledge', async () => {
  const t = setup({ tab: 'activity',
    state: { status: 'quarantined', quarantine: { reason: 'unresponsive', at: at('2026-10-27T10:00:00Z') }, faults: 3, lastFault: { at: at('2026-10-27T10:00:00Z'), message: 'It threw', where: 'ComposerBand (x)', stack: 'at line 1' } },
    ops: [
      { id: 'op-1', mod: MOD, state: { kind: 'update', outcome: 'succeeded', startedAt: at('2026-10-28T00:00:01Z') } },
      { id: 'op-2', mod: MOD, state: { kind: 'disable', outcome: 'failed', message: 'no space', startedAt: at('2026-10-28T00:00:02Z') } },
      { id: 'op-3', mod: 'other.mod', state: { kind: 'remove', outcome: 'failed', startedAt: at('2026-10-28T00:00:03Z') } },
      { id: 'op-4', mod: MOD, state: { kind: 'rollback', outcome: 'needsAttention', message: 'look', startedAt: at('2026-10-28T00:00:04Z') } },
    ] });
  const text = t.text();
  assert.match(text, /Activity \/ Since Codex started/);
  assert.match(text, /Last fault \| It threw \(ComposerBand \(x\)\)3 since Codex started/);
  assert.doesNotMatch(text, /at line 1/, 'its stack only with Developer mode on');
  assert.ok(text.indexOf('Turn off · 2026-10-28') < text.indexOf('Update · 2026-10-28'), 'the newest first');
  assert.match(text, /Turn off · 2026-10-28 \| no space \| Failed/);
  assert.doesNotMatch(text, /Remove · /, 'another mod\'s operation is not on this page');
  await t.buttonIn(t.row('Roll back · 2026-10-28'), 'Acknowledge').props.onClick();
  assert.deepEqual(t.calls.filter((c) => c[2] === 'acknowledge'), [['Operation', 'op-4', 'acknowledge', []]]);
  assert.equal(OPERATIONS, 10);
  const dev = setup({ tab: 'activity', fw: { developerMode: true }, state: { lastFault: { at: 1, message: 'm', where: 'w', stack: 'at line 1' } } });
  assert.match(dev.text(), /at line 1/);
  const stoppedAlone = setup({ tab: 'activity', state: { status: 'quarantined', quarantine: { reason: 'crashed', at: at('2026-10-27T10:00:00Z') } } });
  assert.match(stoppedAlone.text(), /Stopped \| crashed/, 'a stop from before its last fault was kept');
  assert.equal(opRef('x').id, 'x');
  assert.equal(modRef('x').id, 'x');
});

test('consent of an install: Review… on its banner, its permissions by risk in a Dialog; Approve and enable names the request; Deny removes it and shows the list', async () => {
  const request = { id: 'req-1', kind: 'install', version: '1.1.0', publisher: 'ab12cd', permissions: ['ui', 'net'], addedPermissions: [] };
  const t = setup({ state: { status: 'pendingConsent', consentRequest: request } });
  const banner = () => t.all((n) => n.props?.className === 'cmk-banner')[0];
  assert.match(textOf(banner()), /^Install 1\.1\.0It asks for 2 permissions\.Review…/);
  assert.match(t.text(), /Waiting for you/);
  assert.equal(t.dialog(), undefined);
  t.buttonIn(banner(), 'Review…').props.onClick();
  assert.match(t.dialogText(), /^Install Demo 1\.1\.0\? — What it may do/);
  assert.match(t.dialogText(), /Publisher: ab12cd/);
  assert.ok(t.dialogText().indexOf('Can reach the network') < t.dialogText().indexOf('Can add controls'), 'the highest risk first');
  assert.equal(t.inDialog('Approve and enable').props.color, 'primary');
  await t.inDialog('Approve and enable').props.onClick();
  await flush();
  assert.deepEqual(t.calls, [['Mod', MOD, 'consent', ['req-1', true, true]]]);
  assert.equal(t.dialog(), undefined, 'it closes once it happened');
  t.buttonIn(banner(), 'Review…').props.onClick();
  await t.inDialog('Deny').props.onClick();
  assert.deepEqual(t.calls[1], ['Mod', MOD, 'consent', ['req-1', false]]);
  assert.deepEqual(t.navigated, ['/settings/codexmods']);
  t.buttonIn(banner(), 'Review…').props.onClick();
  await t.inDialog('Approve').props.onClick();
  assert.deepEqual(t.calls[2], ['Mod', MOD, 'consent', ['req-1', true, false]], 'approved, left off');
  const blocked = setup({ state: { status: 'pendingConsent', compatibility: 'blocked', consentRequest: request }, review: true });
  assert.equal(blocked.inDialog('Approve and enable').props.disabled, true, 'a mod that cannot run here is not enabled');
});

test('consent of an update: what it adds is marked, a publisher change is said plainly; a stale review is not sent', async () => {
  const request = { id: 'req-2', kind: 'update', version: '1.2.0', publisher: 'ef34', permissions: ['ui', 'files'], addedPermissions: ['files'], publisherChange: { from: 'ab12cd', to: 'ef34' } };
  const t = setup({ state: { consentRequest: request, availableVersion: '1.2.0' }, review: true });
  assert.match(t.dialogText(), /^Update Demo to 1\.2\.0\?/, 'opened from the list\'s Review…');
  assert.match(t.dialogText(), /It is signed by a different publisherYou trusted the key ab12cd when you installed it; this update is signed by ef34\./);
  assert.equal(t.inDialog('Approve and enable'), undefined, 'an update keeps the mod as it is');
  t.setMod({ consentRequest: { ...request, id: 'req-3', version: '1.3.0' }, availableVersion: '1.3.0' });
  t.show();
  assert.match(t.dialogText(), /^Update Demo to 1\.2\.0\?/, 'the request it showed');
  assert.match(t.dialogText(), /What waits has changed since you opened this/);
  assert.equal(t.inDialog('Approve').props.disabled, true);
  t.setMod({});
  t.show();
  assert.match(t.dialogText(), /It was answered elsewhere: nothing waits any more\./);
  assert.equal(t.inDialog('Decline the update').props.disabled, true);
  assert.equal(t.calls.length, 0);
  const plain = setup({ state: { consentRequest: { ...request, publisherChange: undefined }, availableVersion: '1.2.0' }, review: true });
  assert.match(plain.dialogText(), /Can read your files · New in this update/);
  assert.match(plain.dialogText(), /The version you have keeps running as it is until you approve\./);
  assert.deepEqual(requestPermissions({ permissions: ['x.unknown', 'ui'], addedPermissions: [] }, PERMS).map((p) => [p.id, p.risk]), [['x.unknown', 'high'], ['ui', 'low']], 'unknown is not low');
});

test('a refusal stays in the Dialog: the Host refuses a stale consent', async () => {
  const request = { id: 'req-1', kind: 'install', version: '1.1.0', permissions: [], addedPermissions: [] };
  const t = setup({ state: { status: 'pendingConsent', consentRequest: request }, review: true, invoke: () => ({ status: 'refused', reason: 'conflict', message: 'what waits for consent is not what was reviewed; look at it again' }) });
  await t.inDialog('Approve').props.onClick();
  await flush();
  assert.match(t.dialogText(), /what waits for consent is not what was reviewed/);
  assert.match(t.dialogText(), /It asks for no permissions\./);
  assert.deepEqual(t.navigated, []);
});

test('roll back asks first and says what each choice keeps and loses; reattach says what it changes; both through the graph', async () => {
  const t = setup({ state: { versions: [{ version: '1.0.0', codeOnly: true, withData: true }, { version: '0.9.0', codeOnly: true, withData: false }],
    keptData: [{ generation: 'g-1', at: at('2026-10-20T08:00:00Z'), bytes: 10 }] } });
  t.buttonIn(t.row('Version 1.0.0'), 'Roll back…').props.onClick();
  assert.match(t.dialogText(), /^Roll back Demo to 1\.0\.0\?Demo goes from 1\.1\.0 back to 1\.0\.0\./);
  assert.match(t.dialogText(), /Keeping its data: its data stays as it is now/);
  assert.match(t.dialogText(), /With its own data: the data saved with 1\.0\.0 comes back, and what changed in it since is lost\./);
  assert.equal(t.inDialog('Roll back with its own data').props.color, 'danger');
  await t.inDialog('Roll back with its own data').props.onClick();
  assert.deepEqual(t.calls.at(-1), ['Mod', MOD, 'rollback', ['1.0.0', true]]);
  t.buttonIn(t.row('Version 0.9.0'), 'Roll back…').props.onClick();
  assert.equal(t.inDialog('Roll back with its own data'), undefined);
  t.inDialog('Cancel').props.onClick();
  assert.equal(t.dialog(), undefined);
  t.buttonIn(t.row('Version 0.9.0'), 'Roll back…').props.onClick();
  await t.inDialog('Roll back, keeping its data').props.onClick();
  assert.deepEqual(t.calls.at(-1), ['Mod', MOD, 'rollback', ['0.9.0', false]]);
  t.buttonIn(t.row('Kept on 2026-10-20'), 'Reattach…').props.onClick();
  assert.match(t.dialogText(), /The data kept on 2026-10-20, 10 bytes, becomes Demo's data again/);
  assert.match(t.dialogText(), /Nothing is replaced: it is refused while Demo has data of its own\./);
  assert.match(t.dialogText(), /Demo is turned off while it happens and on again after\./);
  await t.inDialog('Reattach').props.onClick();
  assert.deepEqual(t.calls.at(-1), ['Mod', MOD, 'reattach', ['g-1']]);
});

test('Uninstall from its menu or its card, then the list', async () => {
  const t = setup({ ops: [{ id: 'op-5', mod: MOD, state: { kind: 'update', outcome: 'needsAttention', message: 'sent requests before reverting' } }] });
  t.pageMenu('Uninstall…').props.onClick();
  assert.match(t.dialogText(), /^Uninstall Demo\?/);
  await t.inDialog('Uninstall').props.onClick();
  await flush();
  assert.deepEqual(t.calls.at(-1), ['Mod', MOD, 'remove', [true]]);
  assert.deepEqual(t.navigated, ['/settings/codexmods']);
  t.buttonIn(t.row('Uninstall Demo'), 'Uninstall…').props.onClick();
  findAll(t.dialog(), (n) => n.props?.role === 'checkbox')[0].props.onClick();
  assert.match(t.dialogText(), /These operations need attention.*Update: sent requests before reverting/);
  await t.inDialog('Uninstall').props.onClick();
  await flush();
  assert.deepEqual(t.calls.at(-1), ['Mod', MOD, 'remove', [false]]);
  const busy = setup({ ops: [{ id: 'op-9', mod: MOD, state: { kind: 'update', outcome: 'running' } }] });
  assert.equal(busy.buttonIn(busy.row('Uninstall Demo'), 'Uninstall…').props.disabled, true);
});

test('update from a file (a folder for a development package) from its menu; Check for updates; a refusal is said under the title', async () => {
  const t = setup();
  t.pageMenu('Update from a file…').props.onClick();
  await flush();
  assert.deepEqual(t.picks, [{ extensions: ['codexmod'] }]);
  assert.deepEqual(t.calls, [['Mod', MOD, 'update', ['/Users/x/demo-1.1.codexmod']]]);
  const d = setup({ state: { development: true }, pickFile: async () => '/Users/x/dev-mod' });
  d.pageMenu('Update from a folder…').props.onClick();
  await flush();
  assert.deepEqual(d.picks, [{ directory: true }]);
  t.pageMenu('Check for updates').props.onClick();
  await flush();
  assert.deepEqual(t.calls[1], ['CodexMods', 'codexmods', 'checkForUpdates', []]);
  const r = setup({ invoke: () => ({ status: 'refused', message: 'not now' }) });
  await r.all((n) => n.type === 'switch')[0].props.onChange(false);
  await flush();
  assert.match(textOf(r.all((n) => n.props?.className === 'cmk-error')[0]), /not now/);
});

test('a mod no longer installed says so', () => {
  const g = setup({ state: null });
  assert.match(g.text(), /This mod isn’t installedIt may have been removed in another window\./);
  g.buttonIn(g.root.tree, 'All mods').props.onClick();
  g.buttonIn(g.root.tree, 'Mods').props.onClick();
  assert.deepEqual(g.navigated, ['/settings/codexmods', '/settings/codexmods']);
});

test('without the app\'s Dialog the same consent runs in the fallback', async () => {
  const request = { id: 'req-1', kind: 'install', version: '1.1.0', permissions: ['ui'], addedPermissions: [] };
  const t = setup({ state: { status: 'pendingConsent', consentRequest: request }, review: true, appDialog: false });
  assert.equal(t.dialog().props['aria-modal'], 'true');
  assert.match(t.dialogText(), /Install Demo 1\.1\.0\?/);
  await t.inDialog('Approve and enable').props.onClick();
  assert.deepEqual(t.calls, [['Mod', MOD, 'consent', ['req-1', true, true]]]);
});

test('E6.6b: what is stored for projects and chats, as stored; one cleared on its own, all after asking', async () => {
  const T = { type: 'Thread', provider: 'codex', id: 't1' }, P = { type: 'Project', provider: 'codex', id: 'p1' };
  const t = setup({ tab: 'settings', state: { storedOverrides: [{ key: 'mode', kind: 'thread', scope: T, value: 'b', seen: false, valid: true }, { key: 'limit', kind: 'project', scope: { ...P, type: 'LocalProject' }, value: 5, seen: false, valid: false }] } });
  assert.match(t.text(), /Stored for projects and chatsmode \| Chat t1: "b"That project or chat is not loaded now \| Clear/);
  assert.match(t.text(), /limit \| Project p1: 5Not used: it is not declared for that scope any more, or no longer valid/);
  await t.buttonIn(t.row('mode'), 'Clear').props.onClick();
  assert.deepEqual(t.calls.at(-1), ['Mod', 'acme.demo', 'clearOverrides', [[{ key: 'mode', scope: T }]]]);
  t.buttonIn(t.row('All of them'), 'Clear all…').props.onClick();
  assert.match(t.dialogText(), /2 values set for particular projects and chats go/);
  await t.inDialog('Clear all').props.onClick();
  assert.deepEqual(t.calls.at(-1), ['Mod', 'acme.demo', 'clearOverrides', []]);
  assert.deepEqual(t.tabs().map((n) => textOf(n))[0], 'Settings', 'its Settings tab shows while any are stored, with no setting declared');
  assert.doesNotMatch(setup().text(), /Stored for projects and chats/);
});

test('E6.5b: its rules that lost to another mod\'s, each with the rule that holds it', () => {
  const t = setup({ tab: 'activity', lost: [{ mod: 'acme.demo', rule: 'swap', kind: 'replace', what: 'SidebarItem', to: 'acme.first' }, { mod: 'acme.demo', rule: 's', kind: 'style', what: '--codex-base-accent', to: 'acme.first' }] });
  assert.match(t.text(), /Rules that lostIts replace of a SidebarItem \| acme\.first's rule holds it: it comes first in your order\. \| swap/);
  assert.match(t.text(), /Its style of --codex-base-accent \| acme\.first's rule holds it/);
  assert.doesNotMatch(setup({ tab: 'activity' }).text(), /Rules that lost/, 'none: no section');
});

test('E6.6c: what it needs (its Features): how many, how many differ, and each one\'s status and details from its Needs row', () => {
  const F = { type: 'Feature', provider: 'codexmods.framework', id: 'slot:composer' }, G = { type: 'Feature', provider: 'codexmods.framework', id: 'slot:bar' };
  const t = setup({ features: [{ ref: F, state: { title: 'The composer', status: 'changed' } }, { ref: G, state: { title: 'The bar', status: 'present' } }] });
  assert.match(t.text(), /Needs \| 2 parts of Codex, 1 not as it expects/);
  t.menuItem(t.row('Needs'), 'The composer: Changed in this build').props.onClick();
  assert.deepEqual(t.details, [F]);
  assert.doesNotMatch(setup().text(), /Needs \|/);
});

test('public hooks H6 (§3.9): what it may do without asking, each with its why, bounds and rate and its switch; off and unavailable while the mod is off', async () => {
  const automatic = [{ id: 'auto-continue', operation: 'Thread.send', why: 'Keeps a chat going', perHour: 30, where: { status: 'idle' }, on: false },
    { id: 'compact', operation: 'Thread.compact', why: 'Saves context', perHour: 5, on: true }];
  const t = setup({ tab: 'permissions', state: { status: 'enabled', automatic } });
  assert.match(t.text(), /What it may do without askingAuto continue \| Keeps a chat goingThread\.send, only where \{"status":"idle"\}, at most 30 an hour/);
  const sw = (row) => findAll(t.row(row), (n) => n.type === 'switch')[0];
  assert.deepEqual([sw('Auto continue').props.checked, sw('Compact').props.checked], [false, true]);
  await sw('Auto continue').props.onChange(true);
  await sw('Compact').props.onChange(false);
  assert.deepEqual(t.calls.slice(-2), [['Mod', 'acme.demo', 'setAutomatic', ['auto-continue', true]], ['Mod', 'acme.demo', 'setAutomatic', ['compact', false]]]);
  const off = setup({ tab: 'permissions', state: { status: 'disabled', automatic: automatic.map((a) => ({ ...a, on: false })) } });
  assert.equal(findAll(off.row('Auto continue'), (n) => n.type === 'switch')[0].props.disabled, true);
  assert.match(off.text(), /It can be turned on while the mod is on/);
  assert.doesNotMatch(setup({ tab: 'permissions' }).text(), /What it may do without asking/, 'none declared: no section');
});

test('public hooks H6 (§3.7): its policies, each with what it does and when, and its switch', async () => {
  const policies = [
    { id: 'no-night', title: 'No sends at night', on: true, spec: { on: { type: 'Thread', operation: 'send' }, origin: 'user', schedule: { between: ['22:00', '06:00'], days: ['mon', 'tue'] }, then: { refuse: 'Sleep on it' } } },
    { id: 'confirm', title: 'Confirm archives', on: false, spec: { on: { type: 'Thread', operation: 'archive' }, then: { ask: { title: 'Archive this chat?' } } } },
  ];
  const t = setup({ tab: 'permissions', state: { status: 'enabled', policies } });
  assert.match(t.text(), /Its policiesNo sends at night \| Refuses Thread\.send: “Sleep on it”; only your own actions, between 22:00 and 06:00 on mon, tue/);
  assert.match(t.text(), /Confirm archives \| Asks you before Thread\.archive: “Archive this chat\?”/);
  const sw = (row) => findAll(t.row(row), (n) => n.type === 'switch')[0];
  assert.deepEqual([sw('No sends at night').props.checked, sw('Confirm archives').props.checked], [true, false]);
  await sw('No sends at night').props.onChange(false);
  assert.deepEqual(t.calls.at(-1), ['Mod', 'acme.demo', 'setPolicy', ['no-night', false]]);
  assert.doesNotMatch(setup({ tab: 'permissions' }).text(), /Its policies/);
});

test('public hooks H6 (§3.7): a request policy says what it answers before you are asked', () => {
  const t = setup({ tab: 'permissions', state: { status: 'enabled', policies: [{ id: 'reads', title: 'Approve reads', on: true, spec: { on: { request: 'CommandApproval' }, then: { answer: { approve: 'once' } }, automatic: 'reads' } }] } });
  assert.match(t.text(), /Approve reads \| Answers CommandApproval before you are asked: approves it once \(its automatic action “reads”\)/);
});

test('public hooks H9 (§3.16): what it gives the agent: its tools, its skills, its instructions; none: no section', () => {
  const agent = { tools: [{ name: 'lookup_ticket', description: 'Finds a ticket by its id' }], skills: ['deploy', 'triage'], instructions: ['text', 'perTurn', 'text'] };
  const t = setup({ tab: 'permissions', state: { status: 'enabled', agent } });
  assert.match(t.text(), /What it gives the agentlookup_ticket \| A tool the agent can call in new chatsFinds a ticket by its id/);
  assert.match(t.text(), /Skills \| deploy, triage/);
  assert.match(t.text(), /Instructions \| Adds its instructions to every chatAdds context to each message you send/);
  assert.doesNotMatch(setup({ tab: 'permissions', state: { status: 'enabled', agent: { tools: [], skills: [], instructions: [] } } }).text(), /What it gives the agent/);
  assert.doesNotMatch(setup({ tab: 'permissions' }).text(), /What it gives the agent/);
});

test('F13: where its rules say it appears, in your words, as declared; F15: opening its page looks at its stop', () => {
  const t = setup({ state: { places: [{ kind: 'add', presentation: 'Sidebar', slot: 'views' }, { kind: 'decorate', presentation: 'SidebarItem' }, { kind: 'host', presentation: 'ComposerBand' }, { kind: 'host', presentation: 'ComposerBand', slot: 'other' }] } });
  assert.match(t.text(), /Where it appearsA sidebar view \| As its rules declare it, while it runs; what shows depends on what is open \| Adds its ownSidebar rows \| {2}\| Adds to itComposer band \| {2}\| Adds its own/);
  assert.equal(t.text().match(/Composer band/g).length, 1, 'each place once, as said');
  assert.doesNotMatch(setup({ state: {} }).text(), /Where it appears/, 'none declared: no section');
  const stopped = setup({ state: { status: 'quarantined', quarantine: { reason: 'faults', at: at('2026-11-03T10:00:00Z') }, stopSeen: false } });
  assert.deepEqual(stopped.calls.filter((c) => c[2] === 'markSeen'), [['Mod', MOD, 'markSeen', []]]);
  const seen = setup({ state: { status: 'quarantined', quarantine: { reason: 'faults', at: at('2026-11-03T10:00:00Z') }, stopSeen: true } });
  assert.deepEqual(seen.calls.filter((c) => c[2] === 'markSeen'), [], 'already looked at');
});
