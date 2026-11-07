// The Developer page (docs/design/framework-ui.md F4, F12): a folder install, safe mode, the framework's state, last-known-good, the update policy, and what belongs to no installed mod.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pagesFixture, at } from './pages-fixture.mjs';
import { createDeveloperPage, ACTIVITY } from '../present/mods-developer.mjs';

function setup(o = {}) {
  const f = pagesFixture(o);
  const page = createDeveloperPage(f.base);
  return { ...f, ...f.mount(() => f.e(page.DeveloperPage)) };
}

test('F12: Developer mode, its switch (CodexMods.setDeveloperMode); Load unpacked only with it on, which it says, through the app\'s folder chooser and CodexMods.install; a cancelled choice does nothing', async () => {
  const off = setup({ pickFile: async () => '/Users/x/dev-mod' });
  assert.match(off.text(), /DevelopmentDeveloper mode \| Load mods from a folder and show full errors \| Load unpacked mod/);
  assert.match(off.text(), /Load unpacked mod \| Turn on Developer mode to load a mod from a folder \| Choose folder…/);
  assert.equal(off.buttonIn(off.row('Load unpacked mod'), 'Choose folder…').props.disabled, true);
  assert.equal(off.switchIn('Developer mode').props.checked, false);
  await off.switchIn('Developer mode').props.onChange(true);
  assert.deepEqual(off.calls, [['CodexMods', 'codexmods', 'setDeveloperMode', [true]]]);
  let next = '/Users/x/dev-mod';
  const t = setup({ fw: { developerMode: true }, pickFile: async () => next });
  assert.equal(t.switchIn('Developer mode').props.checked, true);
  assert.match(t.text(), /Load unpacked mod \| Install a mod from a folder on this computer \| Choose folder…/);
  assert.equal(t.buttonIn(t.row('Load unpacked mod'), 'Choose folder…').props.disabled, false);
  await t.buttonIn(t.row('Load unpacked mod'), 'Choose folder…').props.onClick();
  next = null;
  await t.buttonIn(t.row('Load unpacked mod'), 'Choose folder…').props.onClick();
  assert.deepEqual(t.picks, [{ directory: true }, { directory: true }]);
  assert.deepEqual(t.calls, [['CodexMods', 'codexmods', 'install', ['/Users/x/dev-mod']]]);
  const none = setup({ fw: { developerMode: true }, pickFile: null });
  assert.equal(none.buttonIn(none.row('Load unpacked mod'), 'Choose folder…').props.disabled, true, 'without the app\'s chooser');
});

test('the framework\'s state, Check now and the policy', async () => {
  const t = setup({ fw: { version: '1.0.1', previousVersion: '1.0.0', lastChecked: at('2026-10-28T02:00:00Z'), checkProblem: 'the release source cannot be reached.', lastKnownGood: { app: '26.1016.62342', framework: '1.0.0', at: at('2026-10-27T10:00:00Z') } } });
  assert.match(t.text(), /Version \| Before this: 1\.0\.0 \| 1\.0\.1/);
  assert.match(t.text(), /Last-known-good \| Codex 26\.1016, framework 1\.0\.0, recorded 2026-10-27 \| Restore…/);
  assert.match(t.text(), /Check for updates \| Last checked 2026-10-28The last check could not complete: the release source cannot be reached\. \| Check now/);
  await t.buttonIn(t.row('Check for updates'), 'Check now').props.onClick();
  await t.switchIn('Apply updates automatically').props.onChange(true);
  assert.deepEqual(t.calls, [['CodexMods', 'codexmods', 'checkForUpdates', []], ['CodexMods', 'codexmods', 'setUpdatePolicy', ['auto']]]);
});

test('Recent activity: what belongs to no installed mod, running, needing attention (Acknowledge), failed, reverted, the newest first', async () => {
  const ops = [
    { id: 'op-1', state: { kind: 'install', outcome: 'succeeded', startedAt: at('2026-10-28T00:00:01Z') } },
    { id: 'op-2', mod: 'gone.mod', state: { kind: 'remove', outcome: 'needsAttention', message: 'sent requests before reverting', startedAt: at('2026-10-28T00:00:02Z') } },
    { id: 'op-3', state: { kind: 'frameworkUpdate', outcome: 'needsAttention', acknowledgedAt: at('2026-10-28T01:00:00Z'), startedAt: at('2026-10-28T00:00:03Z') } },
    { id: 'op-4', mod: 'a.x', state: { kind: 'rollback', outcome: 'failed', message: 'no space', startedAt: at('2026-10-28T00:00:04Z') } },
    { id: 'op-5', state: { kind: 'copyUpdate', outcome: 'reverted', message: 'the new copy did not start', startedAt: at('2026-10-28T00:00:05Z') } },
  ];
  const t = setup({ mods: { 'a.x': { name: 'X' } }, ops });
  const text = t.text();
  assert.doesNotMatch(text, /Install \| /, 'a success is not activity to look at');
  assert.doesNotMatch(text, /Framework update/, 'an acknowledged operation no longer needs attention');
  assert.doesNotMatch(text, /Roll back/, 'an installed mod\'s is on its own Activity');
  assert.ok(text.indexOf('Update | the new copy') < text.indexOf('Remove | sent requests'), 'the newest first');
  await t.buttonIn(t.row('Remove'), 'Acknowledge').props.onClick();
  assert.deepEqual(t.calls, [['Operation', 'op-2', 'acknowledge', []]]);
  assert.equal(ACTIVITY, 10);
  assert.deepEqual(t.reported().sort(), [['SettingsRow', 'Operation', 'op-2', 'codexMods', 'activity'], ['SettingsRow', 'Operation', 'op-5', 'codexMods', 'activity']]);
  assert.doesNotMatch(setup().text(), /Recent activity/);
});

test('recovery: safe mode and last-known-good restart Codex, so each asks first; a running operation never holds them', async () => {
  const t = setup({ fw: { lastKnownGood: { app: '26.1016.1', framework: '1.0.0', at: at('2026-10-27T10:00:00Z') } } });
  await t.switchIn('Run Codex without mods').props.onChange(true);
  assert.equal(t.calls.length, 0, 'it asks first');
  assert.match(t.dialogText(), /^Run Codex without mods\?Codex restarts without any mod\. Your mods, their settings and their data stay as they are/);
  await t.inDialog('Turn off mods and restart').props.onClick();
  assert.deepEqual(t.calls, [['CodexMods', 'codexmods', 'enterSafeMode', []]]);
  assert.equal(t.dialog(), undefined);
  t.buttonIn(t.row('Last-known-good'), 'Restore…').props.onClick();
  assert.match(t.dialogText(), /The framework, your mods and their settings go back to how they were with Codex 26\.1016 and framework 1\.0\.0 \(2026-10-27\)/);
  assert.match(t.dialogText(), /Mod data is never rolled back: a mod whose data format changed since stays off\./);
  t.inDialog('Cancel').props.onClick();
  assert.equal(t.calls.length, 1);
  t.buttonIn(t.row('Last-known-good'), 'Restore…').props.onClick();
  await t.inDialog('Restore and restart').props.onClick();
  assert.deepEqual(t.calls[1], ['CodexMods', 'codexmods', 'restoreLastKnownGood', []]);
  const u = setup({ ops: [{ id: 'op-1', state: { kind: 'update', outcome: 'running' } }], fw: { safeMode: true, lastKnownGood: { app: 'a', framework: 'b', at: 1 } } });
  assert.equal(u.switchIn('Run Codex without mods').props.disabled, false, 'the way out of a stuck operation (E6 review)');
  assert.equal(u.buttonIn(u.row('Last-known-good'), 'Restore…').props.disabled, false);
  const v = setup({ fw: { safeMode: true } });
  assert.match(v.text(), /Mods are offCodex is running without mods\. Their settings and permissions are kept\./);
  await v.switchIn('Run Codex without mods').props.onChange(false);
  await v.inDialog('Turn on and restart').props.onClick();
  assert.deepEqual(v.calls, [['CodexMods', 'codexmods', 'leaveSafeMode', []]]);
  assert.equal(v.buttonIn(v.row('Last-known-good'), 'Restore…').props.disabled, true, 'none recorded');
  const w = setup({ fw: { safeMode: true } });
  w.buttonIn(w.root.tree, 'Turn mods back on').props.onClick();
  assert.match(w.dialogText(), /^Turn mods back on\?/, 'the banner asks too');
  assert.equal(setup({ noFramework: true }).text(), 'Developer');
});
